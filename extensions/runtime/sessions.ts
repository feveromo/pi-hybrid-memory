import { existsSync, readFileSync, readdirSync, lstatSync, realpathSync, openSync, readSync, closeSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import { type MemoryRecord } from "../core/domain.ts";
import { isMemoryArtifactPath, isSensitivePath, redactSecrets, sanitizeFilePaths, SECRET_REPLACEMENT } from "../core/privacy.ts";
import { compactText, textParts } from "../core/text.ts";

import { SESSION_ROOT, SESSION_IMPORT_MAX_BYTES, nowIso, stableId, pathContains, findProjectRoot, appendRecordsBatch, appendRecordIfChanged } from "./foundation.ts";
import { hybridMemoryConfig, type AutoCapturePreferenceMode } from "./configuration.ts";

function conciseList(items: string[], maxItems: number, maxEach: number) {
  const cleaned = items.map((item) => compactText(redactSecrets(item), maxEach)).filter(Boolean);
  const shown = cleaned.slice(0, maxItems);
  return cleaned.length > maxItems ? [...shown, `+${cleaned.length - maxItems} more`] : shown;
}

function sessionLocationLabel(importCwd: string, sessionCwd: string) {
  if (sameProject(importCwd, sessionCwd)) {
    const rel = relative(findProjectRoot(importCwd), sessionCwd);
    return rel && !rel.startsWith("..") ? rel : ".";
  }
  return basename(sessionCwd || importCwd);
}

export function boundedNumber(raw: string | number | undefined, fallback: number, min: number, max: number) {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

function likelyDelegatedPrompt(prompt: string) {
  const text = prompt.trim();
  return /^(you are|task:|analyze this conversation|research this topic|review the diff|implement the requested|scout the codebase)\b/i.test(text)
    || /\b(subagent|orchestrator|memory extraction system|produce a concise, well-sourced brief)\b/i.test(text);
}

export function looksLikePastedReviewPrompt(prompt: string) {
  const text = prompt.replace(/\s+/g, " ").trim();
  return text.length > 280
    && /\b(overall|what['’]?s strong|what['’]?s good|main issues|best next fixes|verdict)\b/i.test(text)
    && /\b(reviewed|said this|thoughts|what do you think|fix everything)\b/i.test(text);
}

export function looksLikeContextInspectionText(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return false;
  const quotesHybridMemory = /(?:<hybrid_memory>|\[redacted-hybrid-memory-tag\])/i.test(clean)
    && /\b(?:show|quote|dump|print|exact|exactly|block|context|injected|saw|visible|can see)\b/i.test(clean);
  const asksForInjectedContext = /\b(?:injected|runtime|agent|prompt)\s+context\b/i.test(clean)
    && /\b(?:show|quote|dump|print|exactly|visible|inspect|inspection)\b/i.test(clean);
  const promptDisclosureGuard = /\b(?:do not|don't|avoid|without)\b.{0,80}\b(?:reveal|disclos\w*|dump|show)\b.{0,80}\b(?:system|developer)\s+prompt\b/i.test(clean);
  return quotesHybridMemory || asksForInjectedContext || promptDisclosureGuard;
}

function looksLikeAgentArtifactPrompt(prompt: string) {
  const text = prompt.trim();
  return likelyDelegatedPrompt(text)
    || looksLikePastedReviewPrompt(text)
    || looksLikeContextInspectionText(text)
    || /^<file\s+name=/i.test(text)
    || /(?:\b(?:pi-subagent|pi-subagents|chain-runs)\b|\[read from:|\[write to:)/i.test(text);
}

function durablePreferencePrompt(prompt: string, mode: AutoCapturePreferenceMode = "explicit") {
  if (mode === "off" || looksLikeAgentArtifactPrompt(prompt)) return false;
  const text = prompt.replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (text.length > 1200 && !/^\s*(?:please\s+)?remember\b/i.test(text)) return false;
  const rememberDirective = /\b(?:please\s+)?remember(?:\s+(?:that|to|this)|:|$)/i.test(text)
    && !/\bif\s+you\s+remember\b/i.test(text)
    && (text.length <= 500 || /^\s*(?:please\s+)?remember\b/i.test(text));
  const alwaysNeverDirective = /\balways\s+(?:use|prefer|respond|format|write|ask|avoid|keep|do|include|exclude|call|run|treat|remember)\b/i.test(text)
    || /\bnever\s+(?:use|respond|format|write|ask|do|store|commit|push|run|include|call|treat)\b/i.test(text)
    || /\byou\s+should\s+(?:always|never)\b/i.test(text);
  const explicitPreference = rememberDirective
    || alwaysNeverDirective
    || /\bmy\s+preferences?\b/i.test(text)
    || /\bi\s+prefer\b/i.test(text)
    || /\bprefer(?:red)?\s+(?:style|approach|format|workflow|way)\b/i.test(text);
  const heuristicPreference = explicitPreference
    || /\bi\s+like\b/i.test(text)
    || /\bi\s+don['’]?t\s+want\b/i.test(text);
  if (!(mode === "heuristic" ? heuristicPreference : explicitPreference)) return false;
  const looksLikeOneOffTask = /\b(?:fix|implement|debug|review|summari[sz]e|explain|generate|write|create|update|change)\b/i.test(text)
    && !/\b(?:remember|always|never|my\s+preferences?|i\s+prefer)\b/i.test(text);
  return !looksLikeOneOffTask;
}

export function autoCapturePromptMemory(cwd: string, prompt: string) {
  const config = hybridMemoryConfig(cwd);
  if (!durablePreferencePrompt(prompt, config.autoCapturePreferences)) return { written: 0 };
  const content = compactText(redactSecrets(prompt), config.autoCaptureMaxChars);
  if (content.length < 12 || content === SECRET_REPLACEMENT) return { written: 0 };
  const ts = nowIso();
  const rec: MemoryRecord = {
    id: stableId("preference", content, `auto-prompt:${content}`),
    schemaVersion: 1,
    scope: "user",
    kind: "preference",
    subject: compactText(content, 64),
    content,
    tags: ["auto-captured", "user-stated"],
    status: "active",
    salience: /\b(always|never|remember|preference)\b/i.test(content) ? 4 : 3,
    evidence: { source: "before_agent_start", capturedAt: ts },
    createdAt: ts,
    updatedAt: ts,
  };
  return { written: appendRecordIfChanged(cwd, rec) ? 1 : 0 };
}

function isUserFacingSessionPrompt(prompt: string) {
  const text = prompt.replace(/\s+/g, " ").trim();
  return text.length >= 3 && !looksLikeAgentArtifactPrompt(text);
}

function stripRecipeCommandPrefix(content: string) {
  return content
    .replace(/^Useful (?:commands seen in prior session|project validation commands|validation\/build commands):\s*/i, "")
    .replace(/\.\s+Broader checks used in sessions include\s*/i, "; ")
    .replace(/,\s+(?=(?:HOME=|[A-Za-z0-9_./-]+=|pi\s+|npm\s+|pnpm\s+|yarn\s+|bun\s+|make\s+|node\s+|tsx\s+|python\s+))/g, "; ")
    .replace(/,?\s+and\s+(?=(?:HOME=|[A-Za-z0-9_./-]+=|pi\s+|npm\s+|pnpm\s+|yarn\s+|bun\s+|make\s+|node\s+|tsx\s+|python\s+))/g, "; ")
    .replace(/\.$/, "");
}

export function splitRecipeCommands(content: string) {
  return stripRecipeCommandPrefix(content)
    .split(/;\s*/)
    .map((cmd) => cmd.trim().replace(/[.。]$/, ""))
    .filter(Boolean);
}

export function normalizeCommandForDedupe(cmd: string) {
  return cmd
    .replace(/\s+/g, " ")
    .replace(/\/tmp\/[^\s;|&]+/g, "/tmp/…")
    .replace(/pi-(?:subagent|subagents)-[^\s;|&]+/g, "pi-subagent-…")
    .trim()
    .toLowerCase();
}

function commandFamilyKey(cmd: string) {
  const n = normalizeCommandForDedupe(cmd);
  if (/\bnpm\s+test\b/.test(n)) return "npm test";
  const npmRun = n.match(/\bnpm\s+run\s+([a-z0-9:_-]+)/);
  if (npmRun) return `npm run ${npmRun[1]}`;
  const nodeScript = n.match(/\b(?:node|tsx)\s+(scripts\/[^\s]+)/);
  if (nodeScript) return `node ${nodeScript[1]}`;
  if (/\bpi\s+--no-session\b/.test(n)) return "pi --no-session";
  return n;
}

function hasUsefulProjectAction(cmd: string) {
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:test|install|add|exec|dlx|run\s+(?:test|fixture|validate|smoke|lint|typecheck|build|dev|start))\b/i.test(cmd)
    || /\b(?:pytest|cargo\s+test|go\s+test|deno\s+test|uv\s+run|python\s+-m\s+pytest)\b/i.test(cmd)
    || /\bmake\s+(?:test|check|build|lint|validate)\b/i.test(cmd)
    || /\b(?:node|tsx)\s+(?:scripts\/|--test\b)/i.test(cmd)
    || /\bpi\s+--no-session\b/i.test(cmd);
}

export function isUsefulProjectCommand(cmd: string) {
  if (/secret|token|password|api[_ -]?key/i.test(cmd)) return false;
  return hasUsefulProjectAction(normalizeCommandForDedupe(cmd));
}

function usefulProjectCommandParts(cmd: string) {
  const parts = cmd.split(/\s*(?:&&|\|\||;)\s*/).map((part) => part.trim()).filter(Boolean);
  const usefulParts = parts.filter(isUsefulProjectCommand);
  return usefulParts.length ? usefulParts : isUsefulProjectCommand(cmd) ? [cmd.trim()] : [];
}

function usefulProjectCommandSnippet(cmd: string) {
  const usefulParts = usefulProjectCommandParts(cmd);
  return usefulParts.length ? usefulParts.join(" && ") : undefined;
}

function commandDisplaySnippet(cmd: string) {
  return compactText(cmd.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, ""), 120);
}

export function recipeCommandSnippets(content: string) {
  return [...new Set(splitRecipeCommands(content).flatMap(usefulProjectCommandParts).map(commandDisplaySnippet))];
}

export function recipeCommandFamilyKeys(content: string) {
  return [...new Set(recipeCommandSnippets(content).map(commandFamilyKey))];
}

function sameProject(a: string, b: string) {
  return findProjectRoot(a) === findProjectRoot(b);
}

function readJsonlObjects(file: string): unknown[] {
  if (!existsSync(file)) return [];
  const out: unknown[] = [];
  for (const line of readFileSync(file, "utf8").split(/\n+/).filter(Boolean)) {
    try { out.push(JSON.parse(line)); } catch { /* ignore damaged lines */ }
  }
  return out;
}

function readFirstJsonlObject(file: string): unknown | undefined {
  if (!existsSync(file)) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytes).toString("utf8");
    for (const line of text.split(/\n+/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { return JSON.parse(trimmed); } catch { /* keep looking for first valid line */ }
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore close errors */ }
    }
  }
  return undefined;
}

function sessionDirNameForPath(cwd: string) {
  return `--${resolve(cwd).replace(/^\/+/, "").replace(/[\\/]+/g, "-")}--`;
}

export function listProjectSessionFilesCheap(cwd: string, limit = 3) {
  const roots = [...new Set([findProjectRoot(cwd), resolve(cwd)])];
  const files: string[] = [];
  for (const root of roots) {
    const dir = join(SESSION_ROOT, sessionDirNameForPath(root));
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        const s = lstatSync(p);
        if (!s.isSymbolicLink() && s.isFile() && s.size <= SESSION_IMPORT_MAX_BYTES && p.endsWith(".jsonl")) files.push(p);
      } catch {
        // ignore disappearing session files
      }
    }
  }
  return [...new Set(files)]
    .flatMap((file) => {
      try { return [{ file, mtime: lstatSync(file).mtimeMs }]; } catch { return []; }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((x) => x.file);
}

export function listSessionFiles(limit = 10, projectCwd?: string) {
  const files: Array<{ file: string; mtime: number }> = [];
  const visited = new Set<string>();
  function walk(dir: string) {
    let directory;
    try {
      directory = lstatSync(dir);
      if (directory.isSymbolicLink() || !directory.isDirectory()) return;
    } catch {
      return;
    }
    const inode = `${directory.dev}:${directory.ino}`;
    if (visited.has(inode)) return;
    visited.add(inode);
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const file = join(dir, name);
      try {
        const stat = lstatSync(file);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) walk(file);
        else if (stat.isFile() && stat.size <= SESSION_IMPORT_MAX_BYTES && file.endsWith(".jsonl")) files.push({ file, mtime: stat.mtimeMs });
      } catch {
        // Ignore disappearing or unreadable session paths.
      }
    }
  }
  walk(SESSION_ROOT);
  const root = projectCwd ? findProjectRoot(projectCwd) : undefined;
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .filter(({ file }) => {
      if (!root) return true;
      const first = readFirstJsonlObject(file) as { cwd?: unknown } | undefined;
      return typeof first?.cwd === "string" && pathContains(root, findProjectRoot(first.cwd));
    })
    .slice(0, limit)
    .map((x) => x.file);
}

export type SessionImportOptions = { includeCommandRecipes?: boolean; requireSessionRoot?: boolean };

function validatedSessionFile(file: string, requireSessionRoot = false): string | undefined {
  const resolvedFile = resolve(file);
  if (!resolvedFile.endsWith(".jsonl")) return undefined;
  try {
    const lexical = lstatSync(resolvedFile);
    if (lexical.isSymbolicLink() || !lexical.isFile() || lexical.size > SESSION_IMPORT_MAX_BYTES) return undefined;
    const realFile = realpathSync(resolvedFile);
    if (requireSessionRoot && (!existsSync(SESSION_ROOT) || !pathContains(realpathSync(SESSION_ROOT), realFile))) return undefined;
    return realFile;
  } catch {
    return undefined;
  }
}

function extractSessionRecords(sessionFile: string, importCwd: string, options: SessionImportOptions = {}): MemoryRecord[] {
  const entries = readJsonlObjects(sessionFile) as Array<Record<string, unknown>>;
  if (!entries.length) return [];
  const header = entries.find((e) => e.type === "session") as { cwd?: string; timestamp?: string; id?: string } | undefined;
  const sessionCwd = typeof header?.cwd === "string" ? header.cwd : importCwd;
  const ts = nowIso();
  const userPrompts: string[] = [];
  const assistantTexts: string[] = [];
  const tools = new Set<string>();
  const commandHints = new Set<string>();
  const files = new Set<string>();

  function collectFileHints(value: unknown) {
    if (!value || typeof value !== "object") return;
    const stack = [value as Record<string, unknown>];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const [k, v] of Object.entries(cur)) {
        if (["path", "file", "session", "cwd"].includes(k) && typeof v === "string" && (v.includes("/") || v.includes(".")) && !isSensitivePath(v)) files.add(redactSecrets(v));
        else if (Array.isArray(v)) for (const item of v) if (item && typeof item === "object") stack.push(item as Record<string, unknown>);
        else if (v && typeof v === "object") stack.push(v as unknown as Record<string, unknown>);
      }
    }
  }

  for (const entry of entries) {
    const message = entry.message as { role?: string; content?: unknown } | undefined;
    if (entry.type === "message" && message) {
      if (message.role === "user") userPrompts.push(...textParts(message.content));
      if (message.role === "assistant") assistantTexts.push(...textParts(message.content));
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part && typeof part === "object" && (part as { type?: string }).type === "toolCall") {
            const call = part as { name?: unknown; arguments?: unknown };
            if (typeof call.name === "string") tools.add(call.name);
            if (typeof call.name === "string" && /(?:^|[._-])bash$/i.test(call.name) && call.arguments && typeof call.arguments === "object") {
              const cmd = (call.arguments as { command?: unknown }).command;
              if (typeof cmd === "string" && cmd.length <= 220 && !/secret|token|password|api[_ -]?key/i.test(cmd)) commandHints.add(redactSecrets(cmd));
            }
            collectFileHints(call.arguments);
          }
        }
      }
    }
    collectFileHints(entry.details);
  }

  const subjectBase = header?.id ? `session ${header.id}` : `session ${sessionFile.split("/").pop()}`;
  const location = sessionLocationLabel(importCwd, sessionCwd);
  const recapPrompts = userPrompts.filter(isUserFacingSessionPrompt);
  const delegatedOnly = userPrompts.length > 0 && recapPrompts.length === 0;
  const promptSummary = conciseList(recapPrompts.slice(0, 4), 3, 90).join(" | ");
  const doneHints = conciseList(assistantTexts.filter((t) => /\b(done|built|implemented|fixed|validated|removed|installed)\b/i.test(t)).slice(-2), 2, 120);
  const fileList = (sanitizeFilePaths([...files]) ?? []).filter((f) => !isMemoryArtifactPath(f)).slice(0, 8);
  const records: MemoryRecord[] = [];

  if ((promptSummary || doneHints.length) && !delegatedOnly) {
    records.push({
      id: stableId("session_recap", subjectBase, sessionFile),
      schemaVersion: 1,
      scope: sameProject(importCwd, sessionCwd) ? "project" : "user",
      kind: "session_recap",
      subject: subjectBase,
      content: [`Prior session (${location}): ${promptSummary || "no user prompt text"}.`, doneHints.length ? `Outcomes: ${doneHints.join(" | ")}.` : "", tools.size ? `Tools: ${[...tools].slice(0, 6).join(", ")}.` : ""].filter(Boolean).join(" "),
      tags: ["session-import", "recap"],
      filePaths: fileList,
      status: "active",
      salience: 2,
      evidence: { sessionFile, sessionCwd, importedAt: ts },
      createdAt: ts,
      updatedAt: ts,
    });
  }

  const includeCommandRecipes = options.includeCommandRecipes ?? true;
  const projectCommands = includeCommandRecipes ? conciseList([...new Set([...commandHints].map(usefulProjectCommandSnippet).filter((cmd): cmd is string => Boolean(cmd)))], 5, 140) : [];
  if (projectCommands.length && sameProject(importCwd, sessionCwd)) {
    records.push({
      id: stableId("recipe", `commands from ${subjectBase}`, `${sessionFile}:commands`),
      schemaVersion: 1,
      scope: "project",
      kind: "recipe",
      subject: `commands from ${subjectBase}`.slice(0, 64),
      content: `Useful commands seen in prior session: ${projectCommands.join("; ")}`,
      tags: ["session-import", "commands"],
      filePaths: fileList,
      status: "active",
      salience: 3,
      evidence: { sessionFile, sessionCwd, importedAt: ts },
      createdAt: ts,
      updatedAt: ts,
    });
  }

  for (const prompt of recapPrompts) {
    // Be conservative: only import durable-sounding user preferences, not every
    // angry or situational "I want X now" instruction from old sessions.
    if (!durablePreferencePrompt(prompt)) continue;
    const content = compactText(redactSecrets(prompt), 240);
    records.push({
      id: stableId("preference", content, `auto-prompt:${content}`),
      schemaVersion: 1,
      scope: "user",
      kind: "preference",
      subject: compactText(content, 64),
      content,
      tags: ["session-import", "user-stated"],
      status: "active",
      salience: 3,
      evidence: { sessionFile, sessionCwd, importedAt: ts },
      createdAt: ts,
      updatedAt: ts,
    });
  }

  return records;
}

export function importSessions(cwd: string, sessionFiles: string[], options: SessionImportOptions = {}) {
  const validation = sessionFiles.map((file) => ({ file, accepted: validatedSessionFile(file, options.requireSessionRoot) }));
  const acceptedFiles = [...new Set(validation.flatMap(({ accepted }) => accepted ? [accepted] : []))];
  const skippedFiles = validation.flatMap(({ file, accepted }) => accepted ? [] : [file]);
  const records: MemoryRecord[] = [];
  for (const file of acceptedFiles) {
    records.push(...extractSessionRecords(file, cwd, options));
  }
  const result = appendRecordsBatch(cwd, records);
  return { scanned: acceptedFiles.length, extracted: records.length, written: result.written, sessionFiles: acceptedFiles, skippedFiles };
}

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sectionLines(summary: string, heading: string) {
  const re = new RegExp(`(?:^|\\n)##\\s+${escapeRegex(heading)}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  const match = redactSecrets(summary).match(re);
  if (!match?.[1]) return [];
  return match[1]
    .split("\n")
    .map((line) => line.replace(/^\s*(?:- \[[ x-]\]|[-*]|\d+\.)\s*/i, "").trim())
    .filter((line) => line && !line.startsWith("<") && !line.startsWith("#"))
    .slice(0, 6);
}

function extractFilesBlock(summary: string, tag: "read-files" | "modified-files") {
  const match = redactSecrets(summary).match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match?.[1]) return [];
  return sanitizeFilePaths(match[1].split("\n").map((line) => line.trim()).filter(Boolean)) ?? [];
}

function recordsFromSummary(cwd: string, summary: string, sourceType: "compaction" | "branch_summary", evidence: Record<string, unknown>) {
  const ts = nowIso();
  const filePaths = [...new Set([...extractFilesBlock(summary, "read-files"), ...extractFilesBlock(summary, "modified-files")])].slice(0, 16);
  const records: MemoryRecord[] = [];
  const decisions = sectionLines(summary, "Key Decisions");
  for (const line of decisions) {
    records.push({
      id: stableId("decision", compactText(line, 80), `${sourceType}:${JSON.stringify(evidence)}:${line}`),
      schemaVersion: 1,
      scope: "project",
      kind: "decision",
      subject: compactText(line.replace(/^\*\*([^*]+)\*\*:?.*/, "$1"), 64),
      content: line,
      tags: [sourceType, "summary-mined"],
      filePaths,
      status: "active",
      salience: 4,
      evidence: { ...evidence, sourceSummaryType: sourceType },
      createdAt: ts,
      updatedAt: ts,
    });
  }
  const prefs = sectionLines(summary, "Constraints & Preferences").filter((line) => /\b(prefer|always|never|must|should|constraint|require|local|privacy|native|external|vector|graph)\b/i.test(line));
  for (const line of prefs) {
    records.push({
      id: stableId("preference", compactText(line, 80), `${sourceType}:${JSON.stringify(evidence)}:${line}`),
      schemaVersion: 1,
      scope: "user",
      kind: "preference",
      subject: compactText(line, 64),
      content: line,
      tags: [sourceType, "summary-mined"],
      filePaths,
      status: "active",
      salience: 3,
      evidence: { ...evidence, sourceSummaryType: sourceType },
      createdAt: ts,
      updatedAt: ts,
    });
  }
  const next = sectionLines(summary, "Next Steps").slice(0, 3);
  if (next.length) {
    const content = next.join("; ");
    records.push({
      id: stableId("work_item", compactText(content, 80), `${sourceType}:${JSON.stringify(evidence)}:next`),
      schemaVersion: 1,
      scope: "project",
      kind: "work_item",
      subject: compactText(content, 64),
      content,
      tags: [sourceType, "summary-mined", "active-work"],
      filePaths,
      status: "active",
      salience: 3,
      evidence: { ...evidence, sourceSummaryType: sourceType },
      createdAt: ts,
      updatedAt: ts,
    });
  }
  return records.filter((r) => r.content.length >= 12 && !/none|n\/a|no next steps/i.test(r.content));
}

export function mineSummary(cwd: string, summary: string | undefined, sourceType: "compaction" | "branch_summary", evidence: Record<string, unknown>) {
  if (!summary) return { extracted: 0, written: 0 };
  const records = recordsFromSummary(cwd, summary, sourceType, evidence);
  const result = appendRecordsBatch(cwd, records);
  return { extracted: records.length, written: result.written };
}
