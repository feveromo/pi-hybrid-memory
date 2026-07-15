import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { isPlainObject, kindEnum, type MemoryKind, type MemoryRecord, type MemoryScope, type MemoryStatus } from "../core/domain.ts";
import { isMemoryArtifactPath, redactSecrets, sanitizeFilePaths } from "../core/privacy.ts";
import { compactText } from "../core/text.ts";
import { atomicWriteFileSync } from "../core/atomic-file.ts";

import { AUDITS, ensureDir, nowIso, stableId, pathContains, findProjectRoot, projectMemoryDir, paths, latestRecordsForCwd, isActiveRecord, activeRecords, recordStatus, recordKey, appendRecordsBatch } from "./foundation.ts";
import { hybridMemoryConfig } from "./configuration.ts";
import { repoMapStaleness } from "./repo-context.ts";
import { looksLikePastedReviewPrompt, looksLikeContextInspectionText, splitRecipeCommands, isUsefulProjectCommand, recipeCommandFamilyKeys } from "./sessions.ts";

export type MemoryStatsSnapshot = ReturnType<typeof memoryStatsSnapshot>;
type MemoryDoctorCandidate = { record: MemoryRecord; action: "mark_stale"; reason: string };
type MemoryScopeHint = { record: MemoryRecord; suggestedScope: MemoryScope; reason: string };
type MemoryReviewHint = { record: MemoryRecord; reason: string; suggestion: string };
export type MemoryDoctorPlan = { generatedAt: string; maxActiveSessionRecaps: number; before: MemoryStatsSnapshot; candidates: MemoryDoctorCandidate[]; scopeHints: MemoryScopeHint[]; reviewHints: MemoryReviewHint[] };
export type MemoryDoctorApplyResult = { applied: number; updated: string[]; skipped: string[] };

export type PruneResult = { staleMarked: number; rollupCreated?: MemoryRecord; duplicateGroups: number };

function emptyStatusCounts(): Record<MemoryStatus, number> {
  return { active: 0, done: 0, superseded: 0, stale: 0 };
}

function emptyKindCounts(): Record<MemoryKind, number> {
  return Object.fromEntries(kindEnum.map((kind) => [kind, 0])) as Record<MemoryKind, number>;
}

function hasProjectLocalPath(cwd: string, r: MemoryRecord) {
  const root = findProjectRoot(cwd);
  for (const file of sanitizeFilePaths(r.filePaths) ?? []) {
    if (isMemoryArtifactPath(file)) continue;
    if (isAbsolute(file)) {
      if (pathContains(root, file)) return true;
    } else if (!file.startsWith("..") && !file.startsWith("~")) {
      return true;
    }
  }
  return false;
}

export function scopeMismatchReason(cwd: string, r: MemoryRecord): { suggestedScope: MemoryScope; reason: string } | undefined {
  if (!isActiveRecord(r)) return undefined;
  const hasProjectPath = hasProjectLocalPath(cwd, r);
  if (r.scope === "project" && r.kind === "preference") return { suggestedScope: "user", reason: "preferences are usually user-level unless tied to one repo" };
  if (r.scope === "project" && (r.tags ?? []).some((tag) => tag === "user-stated" || tag === "auto-captured")) return { suggestedScope: "user", reason: "user-stated imported memory landed in project scope" };
  if (r.scope === "user" && ["codebase_note", "project_fact", "recipe"].includes(r.kind) && hasProjectPath) return { suggestedScope: "project", reason: "technical memory references files in the current project" };
  if (r.scope === "project" && ["codebase_note", "project_fact", "recipe"].includes(r.kind) && !hasProjectPath && /\b(?:openwarp|zed|deepseek|gnome|nautilus|desktop|systemd|shell|bashrc|vscode|copilot)\b/i.test(`${r.subject} ${r.content}`)) return { suggestedScope: "user", reason: "machine/setup memory looks global rather than project-local" };
  return undefined;
}

export function scopeMismatchHints(cwd: string, records = activeRecords(latestRecordsForCwd(cwd))): MemoryScopeHint[] {
  return records
    .map((record) => ({ record, hint: scopeMismatchReason(cwd, record) }))
    .filter((x): x is { record: MemoryRecord; hint: { suggestedScope: MemoryScope; reason: string } } => Boolean(x.hint))
    .map((x) => ({ record: x.record, suggestedScope: x.hint.suggestedScope, reason: x.hint.reason }));
}

export function reviewHintReason(cwd: string, r: MemoryRecord): MemoryReviewHint | undefined {
  if (!isActiveRecord(r) || r.pinned || r.kind !== "preference") return undefined;
  const text = `${r.subject} ${r.content}`.replace(/\s+/g, " ").trim();
  const source = r.tags ?? [];
  const summaryMined = source.includes("summary-mined") || source.includes("compaction") || source.includes("branch_summary");
  const thin = r.content.length <= 90 && r.subject.length <= 90;
  if (summaryMined && thin) return { record: r, reason: "thin-summary-mined-preference", suggestion: "review, rewrite with more context, pin if durable, or mark stale if it was a one-off session instruction" };
  const root = findProjectRoot(cwd);
  if ((source.includes("auto-captured") || source.includes("session-import")) && /(?:^|\s)(?:\.\/|\.\.\/|\/[^\s`]+|[\w.-]+\/[\w./-]+)/.test(text) && !text.includes(root)) {
    return { record: r, reason: "path-specific-user-preference", suggestion: "consider moving to a project-local decision/work item, rewriting globally, or marking stale" };
  }
  return undefined;
}

export function memoryReviewHints(cwd: string, records = activeRecords(latestRecordsForCwd(cwd))): MemoryReviewHint[] {
  return records
    .map((record) => reviewHintReason(cwd, record))
    .filter((hint): hint is MemoryReviewHint => Boolean(hint));
}

function duplicateSubjectHints(records: MemoryRecord[], limit = 8) {
  return [...records.reduce((m, r) => m.set(`${r.scope}:${r.kind}:${r.subject}`, (m.get(`${r.scope}:${r.kind}:${r.subject}`) ?? 0) + 1), new Map<string, number>()).entries()]
    .filter(([, count]) => count > 1)
    .slice(0, limit);
}

export function memoryStatsSnapshot(cwd: string) {
  const records = latestRecordsForCwd(cwd);
  const active = activeRecords(records);
  const byScope: Record<MemoryScope, number> = { user: 0, project: 0 };
  const activeByScope: Record<MemoryScope, number> = { user: 0, project: 0 };
  const byStatus = emptyStatusCounts();
  const activeByKind = emptyKindCounts();
  const byKind = emptyKindCounts();
  const statusByScope: Record<MemoryScope, Record<MemoryStatus, number>> = { user: emptyStatusCounts(), project: emptyStatusCounts() };
  for (const r of records) {
    const status = recordStatus(r);
    byScope[r.scope]++;
    byStatus[status]++;
    statusByScope[r.scope][status]++;
    byKind[r.kind]++;
    if (status === "active") {
      activeByScope[r.scope]++;
      activeByKind[r.kind]++;
    }
  }
  const staleCandidateKeys = new Set(memoryCurationCandidates(cwd, hybridMemoryConfig(cwd).pruneActiveSessionRecaps).map((candidate) => recordKey(candidate.record)));
  const scopeHints = scopeMismatchHints(cwd, active);
  const reviewHints = memoryReviewHints(cwd, active);
  return {
    total: records.length,
    active: active.length,
    inactive: records.length - active.length,
    byScope,
    activeByScope,
    byStatus,
    byKind,
    activeByKind,
    statusByScope,
    pinnedActive: active.filter((r) => r.pinned).length,
    pinnedInactive: records.filter((r) => r.pinned && !isActiveRecord(r)).length,
    duplicateSubjects: duplicateSubjectHints(active),
    staleCandidateCount: staleCandidateKeys.size,
    scopeMismatchCount: scopeHints.length,
    reviewHintCount: reviewHints.length,
    repoMap: repoMapStaleness(cwd),
  };
}

export function memoryHealth(cwd: string) {
  const stats = memoryStatsSnapshot(cwd);
  return {
    total: stats.total,
    active: stats.active,
    stale: stats.byStatus.stale,
    superseded: stats.byStatus.superseded,
    done: stats.byStatus.done,
    duplicateSubjects: stats.duplicateSubjects,
    repoMap: stats.repoMap,
    stats,
  };
}

function noisyAutoPreferenceReason(r: MemoryRecord) {
  if (r.kind !== "preference" || !(r.tags ?? []).some((tag) => tag === "auto-captured" || tag === "session-import")) return undefined;
  const content = r.content.replace(/\s+/g, " ").trim();
  if (looksLikePastedReviewPrompt(content)) return "pasted-review-preference";
  if (/\b(?:reviewed .* said this|what .* said about|fix everything that needs to be fixed)\b/i.test(content)) return "review-prompt-preference";
  if (/^(?:ok so|whats this|what's this|dude here's|here's how|so do we need)\b/i.test(content)
    && /\b(?:remove|fix|setup|thoughts|review|proxy|actual app|get rid)\b/i.test(content)) return "situational-task-preference";
  return undefined;
}

export function noisySessionRecapReason(r: MemoryRecord) {
  if (r.kind !== "session_recap" || !(r.tags ?? []).includes("session-import")) return undefined;
  if (looksLikeContextInspectionText(r.content)) return "context-inspection-recap";
  return /(?:\b(?:You are a memory extraction system|You are the orchestrator|Task: Research this topic|pi-subagent|pi-subagents|chain-runs)\b|\[Read from:|\[Write to:)/i.test(r.content)
    ? "delegated-session-recap"
    : undefined;
}

function noisyRecipeReason(r: MemoryRecord) {
  if (r.kind !== "recipe" || !(r.tags ?? []).includes("commands")) return undefined;
  const commands = splitRecipeCommands(r.content);
  return commands.length && !commands.some(isUsefulProjectCommand) ? "generic-command-recipe" : undefined;
}

export function codebaseNoteFileEvidence(cwd: string, filePaths: string[] | undefined) {
  const root = findProjectRoot(cwd);
  return (sanitizeFilePaths(filePaths) ?? []).flatMap((file) => {
    const abs = isAbsolute(file) ? file : join(root, file);
    try {
      if (!existsSync(abs)) return [];
      const stat = statSync(abs);
      if (!stat.isFile()) return [];
      return [{ path: file, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) }];
    } catch {
      return [];
    }
  });
}

function storedCodebaseNoteFileEvidence(r: MemoryRecord) {
  const files = Array.isArray(r.evidence?.files) ? r.evidence.files : [];
  const out = new Map<string, { size?: number; mtimeMs?: number }>();
  for (const item of files) {
    if (!isPlainObject(item) || typeof item.path !== "string") continue;
    out.set(item.path, {
      size: typeof item.size === "number" ? item.size : undefined,
      mtimeMs: typeof item.mtimeMs === "number" ? item.mtimeMs : undefined,
    });
  }
  return out;
}

function staleCodebaseNoteReason(cwd: string, r: MemoryRecord) {
  if (r.kind !== "codebase_note" || r.pinned || !r.filePaths?.length) return undefined;
  if (!hybridMemoryConfig(cwd).staleCodebaseNotesOnFileChange) return undefined;
  const updated = Date.parse(r.updatedAt);
  const root = findProjectRoot(cwd);
  const evidence = storedCodebaseNoteFileEvidence(r);
  for (const file of sanitizeFilePaths(r.filePaths) ?? []) {
    const abs = isAbsolute(file) ? file : join(root, file);
    if (!existsSync(abs)) return `codebase-note-file-missing:${file}`;
    try {
      const stat = statSync(abs);
      const stored = evidence.get(file);
      if (stored?.size !== undefined && stat.size !== stored.size) return `codebase-note-file-changed:${file}`;
      const baselineMtime = stored?.mtimeMs ?? (Number.isFinite(updated) ? updated : undefined);
      if (baselineMtime !== undefined && stat.mtimeMs > baselineMtime + 1000) return `codebase-note-file-changed:${file}`;
    } catch {
      return `codebase-note-file-unreadable:${file}`;
    }
  }
  return undefined;
}

export function staleReasonForMemory(cwd: string, r: MemoryRecord) {
  if (r.pinned) return undefined;
  return noisyAutoPreferenceReason(r) ?? noisySessionRecapReason(r) ?? noisyRecipeReason(r) ?? staleCodebaseNoteReason(cwd, r);
}

function preferredMemoryKeeper(a: MemoryRecord, b: MemoryRecord) {
  return Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.salience - a.salience || b.updatedAt.localeCompare(a.updatedAt);
}

function memoryCurationCandidates(cwd: string, maxActiveSessionRecaps = 12): MemoryDoctorCandidate[] {
  const active = activeRecords(latestRecordsForCwd(cwd));
  const candidates = new Map<string, MemoryDoctorCandidate>();
  const add = (record: MemoryRecord, reason: string) => {
    if (record.pinned) return;
    const key = recordKey(record);
    if (!candidates.has(key)) candidates.set(key, { record, action: "mark_stale", reason });
  };

  const bySubject = new Map<string, MemoryRecord[]>();
  for (const r of active) {
    const hygieneReason = staleReasonForMemory(cwd, r);
    if (hygieneReason) add(r, hygieneReason);
    const key = `${r.scope}:${r.kind}:${r.subject.toLowerCase()}`;
    const arr = bySubject.get(key) ?? [];
    arr.push(r);
    bySubject.set(key, arr);
  }
  for (const group of bySubject.values()) {
    if (group.length < 2) continue;
    group.sort(preferredMemoryKeeper);
    for (const r of group.slice(1)) add(r, "duplicate-subject");
  }

  const recipeGroups = new Map<string, MemoryRecord[]>();
  const recipeCommandSets = active
    .filter((x) => x.kind === "recipe")
    .map((r) => ({ r, commands: recipeCommandFamilyKeys(r.content).sort() }))
    .filter((x) => x.commands.length);
  for (const { r, commands } of recipeCommandSets.filter((x) => !x.r.pinned)) {
    const key = commands.join("; ");
    const arr = recipeGroups.get(key) ?? [];
    arr.push(r);
    recipeGroups.set(key, arr);
  }
  for (const group of recipeGroups.values()) {
    if (group.length < 2) continue;
    group.sort(preferredMemoryKeeper);
    for (const r of group.slice(1)) add(r, "duplicate-command-recipe");
  }
  for (const current of recipeCommandSets.filter((x) => !x.r.pinned)) {
    const covered = recipeCommandSets.some((other) => {
      if (other.r === current.r) return false;
      if (!other.r.pinned && other.r.updatedAt < current.r.updatedAt) return false;
      const otherSet = new Set(other.commands);
      return current.commands.every((cmd) => otherSet.has(cmd)) && other.commands.length >= current.commands.length;
    });
    if (covered) add(current.r, "covered-command-recipe");
  }

  const recapLimit = (scope: MemoryScope) => scope === "project" ? maxActiveSessionRecaps : Math.max(8, maxActiveSessionRecaps);
  const recapsByScope = new Map<MemoryScope, MemoryRecord[]>();
  for (const r of active.filter((x) => x.kind === "session_recap" && !x.pinned)) {
    const arr = recapsByScope.get(r.scope) ?? [];
    arr.push(r);
    recapsByScope.set(r.scope, arr);
  }
  for (const [scope, recaps] of recapsByScope.entries()) {
    recaps.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const r of recaps.slice(recapLimit(scope))) add(r, "old-session-recap");
  }

  return [...candidates.values()].sort((a, b) => a.record.scope.localeCompare(b.record.scope) || a.record.kind.localeCompare(b.record.kind) || a.reason.localeCompare(b.reason));
}

export function memoryDoctorPlan(cwd: string, maxActiveSessionRecaps = hybridMemoryConfig(cwd).pruneActiveSessionRecaps): MemoryDoctorPlan {
  const active = activeRecords(latestRecordsForCwd(cwd));
  return {
    generatedAt: nowIso(),
    maxActiveSessionRecaps,
    before: memoryStatsSnapshot(cwd),
    candidates: memoryCurationCandidates(cwd, maxActiveSessionRecaps),
    scopeHints: scopeMismatchHints(cwd, active),
    reviewHints: memoryReviewHints(cwd, active),
  };
}

export function applyMemoryDoctorPlan(cwd: string, plan: MemoryDoctorPlan): MemoryDoctorApplyResult {
  const result: MemoryDoctorApplyResult = { applied: 0, updated: [], skipped: [] };
  const latest = new Map(latestRecordsForCwd(cwd).map((r) => [recordKey(r), r]));
  const now = nowIso();
  const updates: MemoryRecord[] = [];
  for (const candidate of plan.candidates) {
    const current = latest.get(recordKey(candidate.record));
    if (!current || !isActiveRecord(current)) {
      result.skipped.push(`${recordKey(candidate.record)} (${candidate.reason})`);
      continue;
    }
    updates.push({
      ...current,
      status: "stale",
      evidence: { ...(current.evidence ?? {}), doctorReason: candidate.reason, doctoredAt: now },
      updatedAt: now,
    });
  }
  const written = appendRecordsBatch(cwd, updates);
  result.applied = written.records.length;
  result.updated.push(...written.records.map(recordKey));
  for (const update of updates) if (!written.records.some((r) => recordKey(r) === recordKey(update))) result.skipped.push(`${recordKey(update)} (unchanged)`);
  return result;
}

function formatScopeStatusLine(label: string, counts: Record<MemoryStatus, number>) {
  return `${label}: active ${counts.active}, stale ${counts.stale}, superseded ${counts.superseded}, done ${counts.done}`;
}

export function formatMemoryStatsText(stats: MemoryStatsSnapshot, p?: ReturnType<typeof paths>) {
  const lines = [
    `Hybrid memory: ${stats.active} active / ${stats.total} total heads`,
    `${formatScopeStatusLine("user", stats.statusByScope.user)}; ${formatScopeStatusLine("project", stats.statusByScope.project)}`,
    `inactive: stale ${stats.byStatus.stale}, superseded ${stats.byStatus.superseded}, done ${stats.byStatus.done}; pinned: ${stats.pinnedActive} active${stats.pinnedInactive ? `, ${stats.pinnedInactive} inactive` : ""}`,
    `hygiene: ${stats.duplicateSubjects.length} duplicate subject group${stats.duplicateSubjects.length === 1 ? "" : "s"}; ${stats.staleCandidateCount} stale/noisy candidate${stats.staleCandidateCount === 1 ? "" : "s"}; ${stats.scopeMismatchCount} scope review hint${stats.scopeMismatchCount === 1 ? "" : "s"}; ${stats.reviewHintCount} preference review hint${stats.reviewHintCount === 1 ? "" : "s"}`,
    `repo map: ${stats.repoMap.stale ? `stale (${stats.repoMap.reason})` : "fresh"}`,
  ];
  if (p) lines.push(`user: ${p.user}`, `project: ${p.project}`);
  return lines.join("\n");
}

export function formatMemoryDoctorReport(input: { plan: MemoryDoctorPlan; applyResult?: MemoryDoctorApplyResult; after?: MemoryStatsSnapshot }) {
  const { plan, applyResult, after } = input;
  const lines = [
    `<!-- Generated by pi-hybrid-memory /hmemory-doctor. Safe cleanup is append-only and deterministic. -->`,
    `Generated: ${plan.generatedAt}`,
    `Mode: ${applyResult ? "apply" : "preview"}`,
    `Safe cleanup candidates: ${plan.candidates.length}`,
    `Scope review hints: ${plan.scopeHints.length}`,
    `Preference review hints: ${plan.reviewHints.length}`,
    `Max active session recaps: ${plan.maxActiveSessionRecaps}`,
    "",
    "## Before",
    formatMemoryStatsText(plan.before),
  ];
  if (after) lines.push("", "## After", formatMemoryStatsText(after));
  lines.push("", "## Safe cleanup candidates");
  if (!plan.candidates.length) lines.push("No deterministic stale/noisy/duplicate candidates found.");
  for (const candidate of plan.candidates) {
    lines.push(`- mark stale ${recordKey(candidate.record)} [${candidate.record.kind}] “${redactSecrets(compactText(candidate.record.subject, 90))}” — ${candidate.reason}`);
  }
  lines.push("", "## Scope review hints");
  if (!plan.scopeHints.length) lines.push("No obvious user/project scope mismatches found.");
  for (const hint of plan.scopeHints.slice(0, 40)) {
    lines.push(`- review ${recordKey(hint.record)} [${hint.record.kind}] → maybe ${hint.suggestedScope}: ${hint.reason}`);
  }
  if (plan.scopeHints.length > 40) lines.push(`- … ${plan.scopeHints.length - 40} more scope hints omitted from this report.`);
  lines.push("", "## Preference review hints");
  if (!plan.reviewHints.length) lines.push("No low-context active preferences need manual review.");
  for (const hint of plan.reviewHints.slice(0, 40)) {
    lines.push(`- review ${recordKey(hint.record)} “${redactSecrets(compactText(hint.record.subject, 90))}” — ${hint.reason}; ${hint.suggestion}`);
  }
  if (plan.reviewHints.length > 40) lines.push(`- … ${plan.reviewHints.length - 40} more preference review hints omitted from this report.`);
  if (applyResult) {
    lines.push("", "## Apply result", `Applied: ${applyResult.applied}`, `Skipped: ${applyResult.skipped.length}`);
    if (applyResult.updated.length) lines.push(`Updated: ${applyResult.updated.join(", ")}`);
    if (applyResult.skipped.length) lines.push("Skipped:", ...applyResult.skipped.map((s) => `- ${s}`));
  }
  lines.push("", "---", "No records were deleted. `/hmemory-doctor apply` only appends stale statuses for deterministic hygiene candidates. Use `/hmemory-audit` for model-assisted rewrites, merges, or new clean records.");
  return lines.join("\n");
}

export function writeMemoryDoctorReport(cwd: string, report: string, mode: "preview" | "apply") {
  const dir = join(projectMemoryDir(cwd), AUDITS);
  ensureDir(dir);
  const file = join(dir, `${nowIso().replace(/[:.]/g, "-")}-hmemory-doctor-${mode}.md`);
  atomicWriteFileSync(file, report.trim() + "\n");
  return file;
}

export function pruneMemory(cwd: string, maxActiveSessionRecaps = 12): PruneResult {
  const active = activeRecords(latestRecordsForCwd(cwd));
  const staleIds = new Set<string>();
  const staleReasons = new Map<string, string>();
  const markStale = (r: MemoryRecord, reason: string) => {
    if (r.pinned) return;
    const key = recordKey(r);
    staleIds.add(key);
    if (!staleReasons.has(key)) staleReasons.set(key, reason);
  };
  const bySubject = new Map<string, MemoryRecord[]>();
  for (const r of active) {
    const hygieneReason = staleReasonForMemory(cwd, r);
    if (hygieneReason) markStale(r, hygieneReason);
    const key = `${r.scope}:${r.kind}:${r.subject.toLowerCase()}`;
    const arr = bySubject.get(key) ?? [];
    arr.push(r);
    bySubject.set(key, arr);
  }
  let duplicateGroups = 0;
  for (const group of bySubject.values()) {
    if (group.length < 2) continue;
    duplicateGroups++;
    group.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const r of group.slice(1)) markStale(r, "duplicate-subject");
  }
  const recipeGroups = new Map<string, MemoryRecord[]>();
  const recipeCommandSets = active
    .filter((x) => x.kind === "recipe")
    .map((r) => ({ r, commands: recipeCommandFamilyKeys(r.content).sort() }))
    .filter((x) => x.commands.length);
  for (const { r, commands } of recipeCommandSets.filter((x) => !x.r.pinned)) {
    const key = commands.join("; ");
    const arr = recipeGroups.get(key) ?? [];
    arr.push(r);
    recipeGroups.set(key, arr);
  }
  for (const group of recipeGroups.values()) {
    if (group.length < 2) continue;
    duplicateGroups++;
    group.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const r of group.slice(1)) markStale(r, "duplicate-command-recipe");
  }
  for (const current of recipeCommandSets.filter((x) => !x.r.pinned)) {
    const covered = recipeCommandSets.some((other) => {
      if (other.r === current.r) return false;
      if (!other.r.pinned && other.r.updatedAt < current.r.updatedAt) return false;
      const otherSet = new Set(other.commands);
      return current.commands.every((cmd) => otherSet.has(cmd)) && other.commands.length >= current.commands.length;
    });
    if (covered) markStale(current.r, "covered-command-recipe");
  }
  const recapLimit = (scope: MemoryScope) => scope === "project" ? maxActiveSessionRecaps : Math.max(8, maxActiveSessionRecaps);
  const recapsByScope = new Map<MemoryScope, MemoryRecord[]>();
  for (const r of active.filter((x) => x.kind === "session_recap" && !x.pinned)) {
    const arr = recapsByScope.get(r.scope) ?? [];
    arr.push(r);
    recapsByScope.set(r.scope, arr);
  }
  const projectRecaps = (recapsByScope.get("project") ?? []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const [scope, recaps] of recapsByScope.entries()) {
    recaps.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const r of recaps.slice(recapLimit(scope))) markStale(r, "old-session-recap");
  }
  const oldRecaps = projectRecaps.slice(maxActiveSessionRecaps).filter((r) => !staleReasonForMemory(cwd, r));
  const now = nowIso();
  const activeByKey = new Map(active.map((r) => [recordKey(r), r]));
  const updates: MemoryRecord[] = [];
  for (const key of staleIds) {
    const existing = activeByKey.get(key);
    if (!existing) continue;
    const reason = staleReasons.get(key) ?? "memory-prune";
    updates.push({
      ...existing,
      status: "stale",
      evidence: { ...(existing.evidence ?? {}), pruneReason: reason, prunedAt: now },
      updatedAt: now,
    });
  }
  let rollupCreated: MemoryRecord | undefined;
  if (oldRecaps.length >= 3) {
    const content = `Rolled up ${oldRecaps.length} older project session recaps. Recent themes: ${oldRecaps.slice(0, 8).map((r) => compactText(r.content, 120)).join(" | ")}`;
    rollupCreated = {
      id: stableId("session_recap", "rolled up older project sessions", oldRecaps.map(recordKey).join("|")),
      schemaVersion: 1,
      scope: "project",
      kind: "session_recap",
      subject: "rolled up older project sessions",
      content,
      tags: ["prune-rollup", "session-import", "recap"],
      filePaths: [...new Set(oldRecaps.flatMap((r) => r.filePaths ?? []))].slice(0, 16),
      status: "active",
      salience: 2,
      evidence: { rolledUp: oldRecaps.map(recordKey), prunedAt: now },
      createdAt: now,
      updatedAt: now,
    };
    updates.push(rollupCreated);
  }
  const result = appendRecordsBatch(cwd, updates);
  const writtenKeys = new Set(result.records.map(recordKey));
  if (rollupCreated && !writtenKeys.has(recordKey(rollupCreated))) rollupCreated = undefined;
  const staleMarked = result.records.filter((r) => r.status === "stale").length;
  return { staleMarked, rollupCreated, duplicateGroups };
}
