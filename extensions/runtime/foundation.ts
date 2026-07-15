import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

import { withCrossProcessFileLocks } from "../core/file-lock.ts";
import { atomicWriteFileSync } from "../core/atomic-file.ts";

import { safeRepoFile } from "../core/repo-path.ts";

import { kindEnum, SCHEMA_VERSION, scopeEnum, type MemoryKind, type MemoryRecord, type MemoryScope, type MemoryStatus, type RepoMap } from "../core/domain.ts";
import { normalizeMemoryRecord, redactSecrets, sanitizeFilePaths, sanitizeRecordForStorage } from "../core/privacy.ts";
import { compactText } from "../core/text.ts";

const USER_MEMORY_DIR = join(homedir(), ".pi", "agent", "memory");
export const RECORDS = "records.jsonl";
const SUMMARY = "summary.md";
const STATE = "state.json";
export const ACTIVE = "active.json";
export const REPOMAP = "repomap.json";
export const CONTEXT = "context.md";
export const AUDITS = "audits";
export const AUDIT_RECORD_LIMIT = 80;
export const AUDIT_PACKET_MAX_CHARS = 18_000;
export const REPO_STALENESS_CACHE_TTL_MS = 15_000;
export const DEFAULT_REPO_MAP_WALK_FALLBACK_LIMIT = 2000;
export const RECIPE_DISPLAY_COMMAND_LIMIT = 6;
export const SESSION_ROOT = join(homedir(), ".pi", "agent", "sessions");
export const SESSION_IMPORT_MAX_BYTES = 1_500_000;
export const HYBRID_MEMORY_CONTEXT_TYPE = "hybrid-memory-context";
export const HYBRID_MEMORY_TOOL_NAMES = [
  "hybrid_memory_remember",
  "hybrid_memory_search",
  "hybrid_memory_forget",
  "hybrid_memory_import_sessions",
  "hybrid_memory_refresh_context",
  "hybrid_memory_bootstrap_project",
  "hybrid_memory_stats",
  "hybrid_memory_doctor",
  "hybrid_memory_explain",
  "hybrid_memory_build_repomap",
] as const;
export const HYBRID_MEMORY_TOOL_NAME_SET = new Set<string>(HYBRID_MEMORY_TOOL_NAMES);

export type RepoSnapshot = {
  root: string;
  files: Array<{ path: string; file: NonNullable<ReturnType<typeof safeRepoFile>> }>;
  totalFiles: number;
};

export type RepoMapStaleness = { stale: boolean; reason: string };

type RepoStalenessCacheEntry = {
  checkedAt: number;
  mapGeneratedAt?: string;
  result: RepoMapStaleness;
};

type RecordsFileCacheEntry = {
  size: number;
  mtimeMs: number;
  records: MemoryRecord[];
};

type LatestRecordsCacheEntry = {
  signature: string;
  records: MemoryRecord[];
};

type RepoMapFileCacheEntry = {
  size: number;
  mtimeMs: number;
  map?: RepoMap;
};

export const repoStalenessCache = new Map<string, RepoStalenessCacheEntry>();
const recordsFileCache = new Map<string, RecordsFileCacheEntry>();
const latestRecordsCache = new Map<string, LatestRecordsCacheEntry>();
export const repoMapFileCache = new Map<string, RepoMapFileCacheEntry>();
let projectContextRegenerator: (cwd: string) => void = () => {};

export function setProjectContextRegenerator(regenerator: (cwd: string) => void) {
  projectContextRegenerator = regenerator;
}

export function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe hybrid-memory directory: ${dir}`);
  chmodSync(dir, 0o700);
}

function ensurePrivateFile(file: string, initialContents: string) {
  if (!existsSync(file)) writeFileSync(file, initialContents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe hybrid-memory file: ${file}`);
  chmodSync(file, 0o600);
}

function jsonLine(record: unknown) {
  return JSON.stringify(record) + "\n";
}

export function nowIso() {
  return new Date().toISOString();
}

let memoryIdCounter = 0;

export function safeId(kind: string, subject: string) {
  const key = `${kind}-${subject}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 56) || "memory";
  return `${key}-${Date.now().toString(36)}-${(memoryIdCounter++).toString(36)}`;
}

function hashString(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function stableId(kind: string, subject: string, evidenceKey: string) {
  const key = `${kind}-${subject}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "memory";
  return `${key}-${hashString(evidenceKey)}`;
}

export function pathContains(parent: string, child: string) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function hasProjectPiMarker(dir: string) {
  const piDir = join(dir, ".pi");
  return existsSync(join(piDir, "settings.json"))
    || existsSync(join(piDir, "SYSTEM.md"))
    || existsSync(join(piDir, "APPEND_SYSTEM.md"))
    || existsSync(join(piDir, "AGENTS.md"))
    || existsSync(join(piDir, "hybrid-memory"));
}

export function findProjectRoot(cwd: string): string {
  const start = resolve(cwd);
  let cur = start;
  while (true) {
    if (existsSync(join(cur, ".git")) || existsSync(join(cur, "package.json"))) return cur;
    if ((cur === start && existsSync(join(cur, ".pi"))) || hasProjectPiMarker(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return start;
    cur = parent;
  }
}

export function projectMemoryDir(cwd: string) {
  // Use a package-specific directory so this never collides with the old
  // @samfp/pi-memory default at ~/.pi/memory or with generic project memory.
  return join(findProjectRoot(cwd), ".pi", "hybrid-memory");
}

export function paths(cwd: string) {
  return {
    user: USER_MEMORY_DIR,
    project: projectMemoryDir(cwd),
  } as const;
}

export async function withHybridMemoryMutation<T>(cwd: string, fn: () => T | Promise<T>): Promise<T> {
  const p = paths(cwd);
  const files = [join(p.user, RECORDS), join(p.project, RECORDS)];
  // Pi's queue covers concurrent tools in this process. The filesystem locks
  // extend the same mutation boundary across multiple Pi processes.
  return withFileMutationQueue(join(p.user, RECORDS), () =>
    withFileMutationQueue(join(p.project, RECORDS), () =>
      withCrossProcessFileLocks(files, fn)));
}

export function initializeDir(dir: string, scope: MemoryScope) {
  ensureDir(dir);
  const records = join(dir, RECORDS);
  ensurePrivateFile(records, "");
  const summary = join(dir, SUMMARY);
  ensurePrivateFile(summary, `# ${scope === "user" ? "User" : "Project"} Memory\n\n_No active memories yet._\n`);
  const state = join(dir, STATE);
  ensurePrivateFile(state, JSON.stringify({ schemaVersion: SCHEMA_VERSION, scope, updatedAt: nowIso() }, null, 2) + "\n");
  if (scope === "project") {
    const active = join(dir, ACTIVE);
    ensurePrivateFile(active, JSON.stringify({ schemaVersion: SCHEMA_VERSION, activeWork: [] }, null, 2) + "\n");
  }
}

function readRecordsFile(file: string): MemoryRecord[] {
  if (!existsSync(file)) return [];
  const stat = statSync(file);
  const cached = recordsFileCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.records;
  const out: MemoryRecord[] = [];
  const lines = readFileSync(file, "utf8").split(/\n+/).filter(Boolean);
  for (const line of lines) {
    try {
      const r = normalizeMemoryRecord(JSON.parse(line));
      if (r) out.push(r);
    } catch {
      // Keep append-only files resilient to manual edits.
    }
  }
  recordsFileCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, records: out });
  return out;
}

function recordsFileStamp(file: string) {
  if (!existsSync(file)) return `${file}:missing`;
  const stat = statSync(file);
  return `${file}:${stat.size}:${stat.mtimeMs}`;
}

function recordCachePaths(cwd: string) {
  const p = paths(cwd);
  return { user: join(p.user, RECORDS), project: join(p.project, RECORDS) };
}

export function invalidateRecordsCache(cwd: string) {
  const p = recordCachePaths(cwd);
  recordsFileCache.delete(p.user);
  recordsFileCache.delete(p.project);
  latestRecordsCache.delete(`${p.user}|${p.project}`);
}

function latestRecords(records: MemoryRecord[]): MemoryRecord[] {
  const map = new Map<string, MemoryRecord>();
  // IDs are stable per imported source, so the same session can legitimately
  // exist in user and project scopes. Keep scope-specific latest versions so a
  // stale project copy cannot hide an active user copy with the same id.
  for (const r of records) map.set(`${r.scope}:${r.id}`, r);
  return [...map.values()].filter((r) => !r.expiresAt || Date.parse(r.expiresAt) > Date.now());
}

export function latestRecordsForCwd(cwd: string): MemoryRecord[] {
  const p = paths(cwd);
  initializeDir(p.user, "user");
  initializeDir(p.project, "project");
  const files = recordCachePaths(cwd);
  const cacheKey = `${files.user}|${files.project}`;
  const signature = `${recordsFileStamp(files.user)}|${recordsFileStamp(files.project)}`;
  const cached = latestRecordsCache.get(cacheKey);
  if (cached?.signature === signature) return cached.records;
  const records = latestRecords([...readRecordsFile(files.user), ...readRecordsFile(files.project)]);
  latestRecordsCache.set(cacheKey, { signature, records });
  return records;
}

export function isActiveRecord(r: MemoryRecord) {
  return (r.status ?? "active") === "active";
}

export function activeRecords(records: MemoryRecord[]) {
  return records.filter(isActiveRecord);
}

export function recordStatus(r: MemoryRecord): MemoryStatus {
  return r.status ?? "active";
}

export function recordKey(r: Pick<MemoryRecord, "scope" | "id">) {
  return `${r.scope}:${r.id}`;
}

export function recordMeaningfulSnapshot(r: MemoryRecord) {
  const rec = sanitizeRecordForStorage(r);
  return JSON.stringify({
    scope: rec.scope,
    kind: rec.kind,
    subject: rec.subject,
    content: rec.content,
    tags: rec.tags ?? [],
    filePaths: rec.filePaths ?? [],
    symbols: rec.symbols ?? [],
    status: recordStatus(rec),
    salience: rec.salience,
    pinned: Boolean(rec.pinned),
    supersedes: rec.supersedes ?? [],
    expiresAt: rec.expiresAt,
  });
}

function recordAffectsProjectContext(rec: MemoryRecord) {
  return rec.scope === "project"
    || rec.kind === "preference"
    || rec.kind === "work_item"
    || (rec.scope === "user" && (rec.kind === "decision" || rec.kind === "project_fact"));
}

type AppendRecordsBatchResult = { written: number; records: MemoryRecord[]; skipped: number };

export function appendRecordsBatch(cwd: string, records: MemoryRecord[], options: { skipUnchanged?: boolean } = {}): AppendRecordsBatchResult {
  const skipUnchanged = options.skipUnchanged ?? true;
  const latestByKey = new Map(latestRecordsForCwd(cwd).map((r) => [recordKey(r), r]));
  const candidates = new Map<string, MemoryRecord>();
  for (const r of records) {
    const rec = sanitizeRecordForStorage(r);
    const key = recordKey(rec);
    if (skipUnchanged) {
      const existing = candidates.get(key) ?? latestByKey.get(key);
      if (existing && recordMeaningfulSnapshot(existing) === recordMeaningfulSnapshot(rec)) continue;
    }
    candidates.delete(key);
    candidates.set(key, rec);
  }

  const toWrite = [...candidates.values()];
  if (!toWrite.length) return { written: 0, records: [], skipped: records.length };

  const p = paths(cwd);
  const byScope: Record<MemoryScope, MemoryRecord[]> = { user: [], project: [] };
  for (const rec of toWrite) byScope[rec.scope].push(rec);
  const touchedScopes = new Set<MemoryScope>();
  for (const scope of scopeEnum) {
    const scoped = byScope[scope];
    if (!scoped.length) continue;
    const dir = scope === "user" ? p.user : p.project;
    initializeDir(dir, scope);
    appendFileSync(join(dir, RECORDS), scoped.map(jsonLine).join(""), "utf8");
    touchedScopes.add(scope);
  }

  invalidateRecordsCache(cwd);
  for (const scope of touchedScopes) regenerateSummary(cwd, scope);
  if (toWrite.some(recordAffectsProjectContext)) projectContextRegenerator(cwd);
  return { written: toWrite.length, records: toWrite, skipped: records.length - toWrite.length };
}

export function appendRecord(cwd: string, r: MemoryRecord) {
  const result = appendRecordsBatch(cwd, [r], { skipUnchanged: false });
  return result.records[0] ?? sanitizeRecordForStorage(r);
}

export function appendRecordIfChanged(cwd: string, r: MemoryRecord) {
  return appendRecordsBatch(cwd, [r]).written > 0;
}

export type UpdateRecordResult = { updated?: MemoryRecord; ambiguous?: MemoryRecord[] };

export function parseScopedId(rawId: string): { id: string; scope?: MemoryScope } {
  const m = rawId.match(/^(user|project):(.+)$/);
  return m ? { scope: m[1] as MemoryScope, id: m[2] } : { id: rawId };
}

export function updateRecord(cwd: string, rawId: string, patch: Partial<MemoryRecord>, scope?: MemoryScope): UpdateRecordResult {
  const parsed = parseScopedId(rawId);
  const wantedScope = scope ?? parsed.scope;
  const matches = latestRecordsForCwd(cwd).filter((r) => r.id === parsed.id && (!wantedScope || r.scope === wantedScope));
  if (!matches.length) return {};
  if (matches.length > 1) return { ambiguous: matches };
  const existing = matches[0]!;
  const next = updatedMemoryRecord(existing, patch);
  return { updated: appendRecord(cwd, next) };
}

export function updatedMemoryRecord(existing: MemoryRecord, patch: Partial<MemoryRecord>): MemoryRecord {
  return {
    ...existing,
    ...patch,
    evidence: patch.evidence ? { ...(existing.evidence ?? {}), ...patch.evidence } : existing.evidence,
    id: existing.id,
    scope: existing.scope,
    schemaVersion: 1,
    updatedAt: nowIso(),
  };
}

export function updateResultText(result: UpdateRecordResult, rawId: string, action: string) {
  if (result.updated) return `memory ${recordKey(result.updated)} ${action}`;
  if (result.ambiguous?.length) return `Ambiguous memory id ${rawId}; use ${result.ambiguous.map(recordKey).join(" or ")}.`;
  return `No record found for ${rawId}.`;
}

function inactiveStatusExplanation(status: MemoryStatus) {
  if (status === "active") return "active again";
  return `${status} (inactive; append-only history retained, not hard-deleted)`;
}

export function forgetResultText(result: UpdateRecordResult, rawId: string, status: MemoryStatus, tombstone?: MemoryRecord) {
  if (result.updated) {
    const extra = tombstone ? ` Kept a tiny active do-not-suggest note: ${recordKey(tombstone)}.` : "";
    return `memory ${recordKey(result.updated)} marked ${inactiveStatusExplanation(status)}.${extra}`;
  }
  if (result.ambiguous?.length) return `Ambiguous memory id ${rawId}; use ${result.ambiguous.map(recordKey).join(" or ")}.`;
  return `No record found for ${rawId}.`;
}

export function createForgetTombstone(cwd: string, forgotten: MemoryRecord, note?: string) {
  const subject = `Do not suggest ${forgotten.subject}`;
  const content = compactText(redactSecrets(note?.trim() || `Do not suggest ${forgotten.subject} again unless explicitly requested.`), 240);
  const ts = nowIso();
  const rec: MemoryRecord = {
    id: stableId("preference", subject, `forget-tombstone:${recordKey(forgotten)}`),
    schemaVersion: 1,
    scope: "user",
    kind: "preference",
    subject: compactText(subject, 64),
    content,
    tags: ["forget-tombstone", "do-not-suggest"],
    status: "active",
    salience: 4,
    pinned: true,
    evidence: { source: "hybrid_memory_forget", forgotten: recordKey(forgotten), createdAt: ts },
    createdAt: ts,
    updatedAt: ts,
  };
  appendRecordIfChanged(cwd, rec);
  return latestRecordsForCwd(cwd).find((r) => recordKey(r) === recordKey(rec)) ?? rec;
}

export function resolveRecord(cwd: string, rawId: string, scope?: MemoryScope): UpdateRecordResult {
  const parsed = parseScopedId(rawId);
  const wantedScope = scope ?? parsed.scope;
  const matches = latestRecordsForCwd(cwd).filter((r) => r.id === parsed.id && (!wantedScope || r.scope === wantedScope));
  if (!matches.length) return {};
  if (matches.length > 1) return { ambiguous: matches };
  return { updated: matches[0] };
}

function recordLabel(r: MemoryRecord) {
  return `${recordKey(r)} [${r.kind}${r.pinned ? ", pinned" : ""}${r.status ? `, ${r.status}` : ""}]`;
}

export function formatRecord(r: MemoryRecord) {
  return [
    recordLabel(r),
    `subject: ${redactSecrets(r.subject)}`,
    `content: ${redactSecrets(r.content)}`,
    r.tags?.length ? `tags: ${r.tags.map(redactSecrets).join(", ")}` : "",
    r.filePaths?.length ? `files: ${(sanitizeFilePaths(r.filePaths) ?? []).join(", ")}` : "",
    r.symbols?.length ? `symbols: ${r.symbols.map(redactSecrets).join(", ")}` : "",
    `salience: ${r.salience}  updated: ${r.updatedAt}`,
  ].filter(Boolean).join("\n");
}

function readStateFile(dir: string): Record<string, unknown> {
  const file = join(dir, STATE);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function writeStateFile(dir: string, patch: Record<string, unknown>) {
  const previous = readStateFile(dir);
  atomicWriteFileSync(join(dir, STATE), JSON.stringify({ ...previous, ...patch, schemaVersion: SCHEMA_VERSION, updatedAt: nowIso() }, null, 2) + "\n");
}

export function updateProjectState(cwd: string, patch: Record<string, unknown>) {
  const dir = projectMemoryDir(cwd);
  initializeDir(dir, "project");
  writeStateFile(dir, patch);
}

export function regenerateSummary(cwd: string, scope: MemoryScope) {
  const dir = scope === "user" ? paths(cwd).user : paths(cwd).project;
  const records = activeRecords(latestRecords(readRecordsFile(join(dir, RECORDS))));
  const groups = new Map<MemoryKind, MemoryRecord[]>();
  for (const r of records.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.salience - a.salience)) {
    const arr = groups.get(r.kind) ?? [];
    arr.push(r);
    groups.set(r.kind, arr);
  }
  const lines = [`# ${scope === "user" ? "User" : "Project"} Memory`, "", `Updated: ${nowIso()}`, ""];
  if (records.length === 0) lines.push("_No active memories yet._");
  for (const kind of kindEnum) {
    const arr = groups.get(kind);
    if (!arr?.length) continue;
    lines.push(`## ${kind.replace(/_/g, " ")}`);
    for (const r of arr.slice(0, 20)) lines.push(`- ${r.pinned ? "📌 " : ""}**${redactSecrets(r.subject)}**: ${redactSecrets(r.content)}`);
    lines.push("");
  }
  atomicWriteFileSync(join(dir, SUMMARY), lines.join("\n") + "\n");
  writeStateFile(dir, { scope, activeRecords: records.length });
}
