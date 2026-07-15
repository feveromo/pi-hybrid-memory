import { isAbsolute } from "node:path";
import { boundedStrings, truncateText } from "./limits.ts";
import { isPlainObject, SCHEMA_VERSION, type RepoMap, type RepoMapFile } from "./domain.ts";
import { isNoisyRepoPath, isSensitivePath, redactSecrets } from "./privacy.ts";

export const REPO_MAP_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const REPO_MAP_CACHE_MAX_FILES = 20_000;

function safeRelativeRepoPath(value: unknown) {
  if (typeof value !== "string") return undefined;
  const path = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!path || path.length > 2048 || isAbsolute(path) || path === ".." || path.startsWith("../")) return undefined;
  if (isSensitivePath(path) || isNoisyRepoPath(path)) return undefined;
  return redactSecrets(path);
}

function optionalStrings(value: unknown, maxItems: number, maxLength: number) {
  const strings = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
  return boundedStrings(strings, maxItems, maxLength)?.map(redactSecrets);
}

function normalizeRepoMapFile(value: unknown): RepoMapFile | undefined {
  if (!isPlainObject(value)) return undefined;
  const path = safeRelativeRepoPath(value.path);
  if (!path) return undefined;
  const kind = truncateText(typeof value.kind === "string" ? redactSecrets(value.kind) : "file", 80);
  const size = typeof value.size === "number" && Number.isFinite(value.size)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(value.size)))
    : 0;
  return {
    path,
    kind,
    symbols: optionalStrings(value.symbols, 120, 160) ?? [],
    imports: optionalStrings(value.imports, 40, 240) ?? [],
    commands: optionalStrings(value.commands, 80, 240),
    tools: optionalStrings(value.tools, 80, 160),
    hooks: optionalStrings(value.hooks, 80, 160),
    exports: optionalStrings(value.exports, 120, 160),
    size,
  };
}

/** Treat the cache as untrusted local input before it reaches prompts or UI. */
export function normalizeRepoMap(value: unknown): RepoMap | undefined {
  if (!isPlainObject(value) || value.schemaVersion !== SCHEMA_VERSION) return undefined;
  if (typeof value.root !== "string" || !value.root || value.root.length > 4096) return undefined;
  if (typeof value.generatedAt !== "string" || value.generatedAt.length > 64) return undefined;
  if (!Array.isArray(value.files) || value.files.length > REPO_MAP_CACHE_MAX_FILES) return undefined;
  const files: RepoMapFile[] = [];
  const seen = new Set<string>();
  for (const candidate of value.files) {
    const file = normalizeRepoMapFile(candidate);
    if (!file || seen.has(file.path)) continue;
    seen.add(file.path);
    files.push(file);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    root: truncateText(redactSecrets(value.root), 4096),
    generatedAt: value.generatedAt,
    files,
  };
}
