import { isAbsolute } from "node:path";

import type { searchStatusEnum, MemoryKind, MemoryRecord, MemoryScope, MemoryStatus } from "../core/domain.ts";
import { isMemoryArtifactPath, redactSecrets, sanitizeFilePaths } from "../core/privacy.ts";
import { compactText } from "../core/text.ts";
import { findProjectRoot, isActiveRecord, latestRecordsForCwd, pathContains, recordKey, recordStatus } from "./foundation.ts";

const GENERIC_MEMORY_QUERY_TERMS = new Set([
  "agent", "audit", "code", "context", "display", "docs", "extension", "extensions", "file", "fresh", "implementation", "local", "mcp", "memory", "package", "packages", "pi", "project", "prompt", "repo", "search", "system", "tool", "tools", "user",
]);
const REPO_SYMBOL_NOISE = new Set([
  "and", "as", "class", "def", "else", "false", "for", "from", "if", "import", "in", "is", "let", "not", "null", "or", "return", "to", "true", "until", "var", "while",
]);

export type SearchStatusFilter = typeof searchStatusEnum[number];
export type SearchRecordsOptions = { scope?: MemoryScope; kind?: MemoryKind; status?: SearchStatusFilter; includeInactive?: boolean };
export type PreparedSearchTerm = { variants: string[]; weight: number };

export function displayFilePaths(filePaths: string[] | undefined, max: number) {
  return (sanitizeFilePaths(filePaths) ?? []).filter((p) => !isMemoryArtifactPath(p)).slice(0, max);
}

function isLowSignalSessionFilePath(path: string) {
  const p = path.replace(/\\/g, "/");
  return /\/(?:Pictures\/Screenshots|Screenshots)\//i.test(p)
    || /\.(?:png|jpe?g|gif|webp|mp4|mov|webm)$/i.test(p);
}

function isPackageDocsPath(path: string) {
  const p = path.replace(/\\/g, "/");
  return /(?:^|\/)\.local\/lib\/node_modules\//.test(p)
    || /(?:^|\/)node_modules\/[^/]+(?:\/[^/]+)?\/(?:docs|examples|README\.md)(?:\/|$)/i.test(p);
}

function isProjectDisplayPath(cwd: string, path: string) {
  if (isAbsolute(path)) return pathContains(findProjectRoot(cwd), path);
  return !path.startsWith("..") && !path.startsWith("~") && !isPackageDocsPath(path);
}

export function recordDisplayFilePaths(record: MemoryRecord, max: number) {
  const paths = displayFilePaths(record.filePaths, 24);
  const filtered = record.kind === "session_recap" ? paths.filter((path) => !isLowSignalSessionFilePath(path)) : paths;
  return filtered.slice(0, max);
}

export function injectedRecordFilePaths(cwd: string, record: MemoryRecord, max: number) {
  const paths = recordDisplayFilePaths(record, 24);
  if (record.kind !== "session_recap") return paths.slice(0, max);
  const projectLocal = paths.filter((path) => isProjectDisplayPath(cwd, path));
  const withoutPackageDocs = paths.filter((path) => !isPackageDocsPath(path));
  const preferred = projectLocal.length ? projectLocal : withoutPackageDocs.length ? withoutPackageDocs : paths;
  return preferred.slice(0, max);
}

function recordHasProjectPath(cwd: string, record: MemoryRecord) {
  const root = findProjectRoot(cwd);
  for (const file of sanitizeFilePaths(record.filePaths) ?? []) {
    if (isMemoryArtifactPath(file)) continue;
    if (isAbsolute(file)) {
      if (pathContains(root, file)) return true;
    } else if (record.scope === "project" && !file.startsWith("..")) {
      return true;
    }
  }
  return false;
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[@a-z0-9_./:-]{2,}/g) ?? [];
}

export function searchTermVariants(term: string) {
  const clean = term.toLowerCase().replace(/^[@\-./:]+|[@\-./:]+$/g, "");
  const variants = new Set([term.toLowerCase(), clean].filter(Boolean));
  const scoped = term.match(/@[-a-z0-9_.]+\/[a-z0-9_.-]+/i)?.[0]?.toLowerCase();
  if (scoped) variants.add(scoped);
  if (term.includes(":")) variants.add(term.slice(term.indexOf(":") + 1).toLowerCase());
  return [...variants].filter((variant) => variant.length >= 2);
}

export function distinctiveQueryTerms(query: string) {
  return [...new Set(tokenize(query)
    .flatMap(searchTermVariants)
    .map((term) => term.replace(/^[@\-./:]+|[@\-./:]+$/g, ""))
    .filter((term) => term.length >= 4 && !/^\d+$/.test(term) && !GENERIC_MEMORY_QUERY_TERMS.has(term)))];
}

export function strongQueryTerms(query: string) {
  return distinctiveQueryTerms(query).filter((term) => term.length >= 7 || /[./:_-]/.test(term));
}

type RecordMatchFields = "text" | "all";

function recordDirectlyMatchesTerms(record: MemoryRecord, terms: string[], fields: RecordMatchFields = "all") {
  if (!terms.length) return false;
  const direct = [recordKey(record), record.id, record.kind, record.subject, record.content, ...(record.tags ?? [])];
  if (fields === "all") direct.push(...(sanitizeFilePaths(record.filePaths) ?? []), ...(record.symbols ?? []));
  const haystack = direct.join(" ").toLowerCase();
  return terms.some((term) => searchTermVariants(term).some((variant) => haystack.includes(variant)));
}

function recordDirectlyMatchesQuery(record: MemoryRecord, query: string) {
  const terms = distinctiveQueryTerms(query);
  if (!terms.length) return false;
  const matches = terms.filter((term) => recordDirectlyMatchesTerms(record, [term]));
  return matches.some((term) => term.length >= 7 || /[./:_-]/.test(term)) || matches.length >= 2;
}

export function shouldIncludeSearchHit(cwd: string, record: MemoryRecord, query: string, preparedStrongTerms = strongQueryTerms(query)) {
  if (preparedStrongTerms.length && !recordDirectlyMatchesTerms(record, preparedStrongTerms)) return false;
  if (record.scope === "user" && (record.kind === "codebase_note" || record.kind === "recipe" || record.kind === "project_fact")) {
    return recordHasProjectPath(cwd, record) || recordDirectlyMatchesQuery(record, query);
  }
  return true;
}

export function shouldIncludeInjectionHit(cwd: string, record: MemoryRecord, query: string, preparedStrongTerms = strongQueryTerms(query)) {
  if (record.kind === "session_recap" || record.kind === "recipe") {
    const distinctiveTerms = distinctiveQueryTerms(query);
    if (!distinctiveTerms.length || !recordDirectlyMatchesTerms(record, distinctiveTerms, "text")) return false;
    if (preparedStrongTerms.length && !recordDirectlyMatchesTerms(record, preparedStrongTerms, "text")) return false;
  }
  return shouldIncludeSearchHit(cwd, record, query, preparedStrongTerms);
}

function termLooksExactIdentifier(term: string) {
  return /@[-a-z0-9_.]+\/[a-z0-9_.-]+/i.test(term)
    || /(?:npm|git|github):/i.test(term)
    || /[a-z0-9_.-]+\/[a-z0-9_.-]+/i.test(term)
    || /[a-z0-9]+(?:-[a-z0-9]+){1,}/i.test(term);
}

export function searchTermWeight(term: string) {
  const clean = term.replace(/^[@\-./:]+|[@\-./:]+$/g, "");
  if (!clean || /^\d+$/.test(clean)) return 0;
  if (termLooksExactIdentifier(term)) return 14;
  if (GENERIC_MEMORY_QUERY_TERMS.has(clean)) return 1;
  if (/[./:_-]/.test(term)) return 6;
  if (clean.length >= 8) return 4;
  return 2;
}

export function displayRepoSymbols(symbols: string[], max: number) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const symbol of symbols) {
    const safe = redactSecrets(symbol).trim();
    const clean = safe.toLowerCase().replace(/^[@\-./:]+|[@\-./:]+$/g, "");
    if (!clean || REPO_SYMBOL_NOISE.has(clean) || /^\d+$/.test(clean)) continue;
    if (!/[A-Z_./:-]/.test(safe) && clean.length < 3) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(safe);
    if (out.length >= max) break;
  }
  return out;
}

const recordTextHaystackCache = new WeakMap<MemoryRecord, string>();
const KIND_SCORE_ADJUSTMENT: Partial<Record<MemoryKind, number>> = {
  preference: 6,
  decision: 4,
  project_fact: 4,
  work_item: 3,
  codebase_note: 2,
  recipe: -1,
  session_recap: -4,
};

function recordTextHaystack(record: MemoryRecord) {
  const cached = recordTextHaystackCache.get(record);
  if (cached !== undefined) return cached;
  const value = [recordKey(record), record.id, record.kind, record.subject, record.content].join(" ").toLowerCase();
  recordTextHaystackCache.set(record, value);
  return value;
}

export function prepareSearchTerms(query: string): PreparedSearchTerm[] {
  return [...new Set(tokenize(query))]
    .map((term) => ({ variants: searchTermVariants(term), weight: searchTermWeight(term) }))
    .filter((term) => term.weight > 0);
}

function lexicalRecordScore(record: MemoryRecord, terms: readonly PreparedSearchTerm[]) {
  const haystack = recordTextHaystack(record);
  const pathWeightScale = record.kind === "codebase_note" || record.kind === "work_item" ? 0.5 : record.kind === "recipe" ? 0.2 : 0;
  let lexicalScore = 0;
  for (const { variants, weight } of terms) {
    if (variants.some((variant) => haystack.includes(variant))) lexicalScore += weight;
    if (pathWeightScale > 0 && variants.some((variant) => record.filePaths?.some((path) => path.toLowerCase().includes(variant)))) {
      lexicalScore += Math.max(1, Math.ceil(weight * pathWeightScale));
    }
    if (variants.some((variant) => record.symbols?.some((symbol) => symbol.toLowerCase() === variant))) lexicalScore += Math.max(4, Math.ceil(weight / 2));
    if (variants.some((variant) => record.tags?.some((tag) => tag.toLowerCase() === variant))) lexicalScore += Math.max(2, Math.ceil(weight / 2));
  }
  return lexicalScore;
}

export function shouldInjectPinnedByDefault(cwd: string, record: MemoryRecord) {
  if (!isActiveRecord(record) || !record.pinned) return false;
  if (record.kind === "preference" || record.kind === "decision" || record.kind === "project_fact" || record.kind === "work_item") return true;
  if (record.scope === "project") return true;
  return recordHasProjectPath(cwd, record);
}

export function scoreRecord(record: MemoryRecord, cwd: string, terms: readonly PreparedSearchTerm[], projectRoot = findProjectRoot(cwd)) {
  const active = isActiveRecord(record);
  const lexicalScore = lexicalRecordScore(record, terms);
  if (lexicalScore <= 0) return shouldInjectPinnedByDefault(cwd, record) ? 12 + record.salience : 0;
  let score = lexicalScore + (KIND_SCORE_ADJUSTMENT[record.kind] ?? 0);
  if (active) score += 4;
  if (record.pinned && active) score += 12;
  if (record.status === "done" || record.status === "stale") score -= 6;
  if (record.status === "superseded") score -= 12;
  score += record.salience;
  if (record.scope === "project" && pathContains(projectRoot, cwd)) score += 2;
  return score;
}

function recordMatchesSearchOptions(record: MemoryRecord, options: SearchRecordsOptions = {}) {
  const wantedStatus = options.status ?? (options.includeInactive ? "all" : "active");
  if (wantedStatus !== "all" && recordStatus(record) !== wantedStatus) return false;
  if (options.scope && record.scope !== options.scope) return false;
  if (options.kind && record.kind !== options.kind) return false;
  return true;
}

function scoreRecordWithSearchOptions(record: MemoryRecord, cwd: string, terms: readonly PreparedSearchTerm[], projectRoot: string, options: SearchRecordsOptions = {}) {
  const targetedInactiveStatus = options.status && options.status !== "active" && options.status !== "all";
  if (targetedInactiveStatus && recordStatus(record) === options.status) {
    const lexicalScore = lexicalRecordScore(record, terms);
    if (lexicalScore > 0) return lexicalScore + record.salience + (record.pinned ? 4 : 0);
  }
  return scoreRecord(record, cwd, terms, projectRoot);
}

export function searchRecordsWithOptions(cwd: string, query: string, limit = 12, options: SearchRecordsOptions = {}) {
  const terms = prepareSearchTerms(query);
  const strongTerms = strongQueryTerms(query);
  const root = findProjectRoot(cwd);
  return latestRecordsForCwd(cwd)
    .map((record) => ({ record, score: scoreRecordWithSearchOptions(record, cwd, terms, root, options) }))
    .filter((hit) => recordMatchesSearchOptions(hit.record, options) && hit.score > 0 && shouldIncludeSearchHit(cwd, hit.record, query, strongTerms))
    .sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt))
    .slice(0, limit);
}

export function formatForgetPreview(cwd: string, query: string, status: MemoryStatus) {
  const hits = searchRecordsWithOptions(cwd, query, 8, { status: "active" });
  if (!hits.length) return `No record found for ${query}.`;
  const lines = [
    `No exact memory id found for "${redactSecrets(query)}". Matching active memories:`,
    ...hits.map((hit) => `- ${recordKey(hit.record)} [${hit.record.kind}, score ${hit.score}]: ${redactSecrets(compactText(hit.record.subject, 80))}`),
    `Run /hmemory-forget <scoped-id> ${status} to mark one inactive. Forgetting is append-only; it does not hard-delete history.`,
  ];
  return lines.join("\n");
}
