

import { existsSync, readFileSync, readdirSync, lstatSync, openSync, readSync, closeSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { execFileSync } from "node:child_process";

import { safeRepoFile } from "../core/repo-path.ts";
import { normalizeRepoMap, REPO_MAP_CACHE_MAX_BYTES } from "../core/repo-map-schema.ts";
import { atomicWriteFileSync } from "../core/atomic-file.ts";

import { SCHEMA_VERSION, type RepoMap, type RepoMapFile } from "../core/domain.ts";
import { isHomeRepoNoise, isNoisyRepoPath, isSensitivePath, redactSecrets, REPO_NOISE_TOP_LEVEL, sanitizeFilePaths } from "../core/privacy.ts";
import { compactText } from "../core/text.ts";

import { ACTIVE, REPOMAP, CONTEXT, REPO_STALENESS_CACHE_TTL_MS, DEFAULT_REPO_MAP_WALK_FALLBACK_LIMIT, repoStalenessCache, repoMapFileCache, setProjectContextRegenerator, nowIso, findProjectRoot, projectMemoryDir, initializeDir, latestRecordsForCwd, activeRecords, recordKey, type RepoSnapshot, type RepoMapStaleness } from "./foundation.ts";
import { hybridMemoryConfig } from "./configuration.ts";
import { distinctiveQueryTerms, tokenize, searchTermVariants, searchTermWeight, displayRepoSymbols } from "./retrieval.ts";

function extractRepoDetails(path: string, content: string): Omit<RepoMapFile, "path" | "kind" | "size" | "imports"> {
  const symbols = new Set<string>();
  const commands = new Set<string>();
  const tools = new Set<string>();
  const hooks = new Set<string>();
  const exports = new Set<string>();
  const add = (set: Set<string>, name?: string) => {
    const safe = name ? compactText(redactSecrets(name), 160) : "";
    if (safe) set.add(safe);
  };
  const patterns: Array<[RegExp, Set<string>]> = [
    [/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, symbols],
    [/export\s+default\s+(?:async\s+)?function(?:\s+([A-Za-z_$][\w$]*))?/g, symbols],
    [/(?:export\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g, symbols],
    [/^const\s+([A-Z_][A-Z0-9_]*)\s*=/gm, symbols],
    [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm, symbols],
    [/^\s*def\s+([A-Za-z_][\w]*)/gm, symbols],
    [/^\s*class\s+([A-Za-z_][\w]*)/gm, symbols],
  ];
  for (const [re, set] of patterns) {
    for (const m of content.matchAll(re)) add(set, m[1] ?? (m[0].startsWith("export default function") ? "default" : undefined));
  }
  for (const m of content.matchAll(/registerCommand\(\s*["']([^"']+)["']/g)) add(commands, m[1]);
  for (const m of content.matchAll(/registerTool\(\s*\{[\s\S]*?name:\s*["']([^"']+)["']/g)) add(tools, m[1]);
  for (const m of content.matchAll(/\.on\(\s*["']([^"']+)["']/g)) add(hooks, m[1]);
  for (const m of content.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)?\s*([A-Za-z_$][\w$]*)?/g)) add(exports, m[1] ?? (m[0].includes("default") ? "default" : undefined));
  for (const x of [...commands, ...tools, ...hooks]) symbols.add(x);
  return { symbols: [...symbols].slice(0, 120), commands: [...commands], tools: [...tools], hooks: [...hooks], exports: [...exports] };
}

function extractImports(content: string): string[] {
  const imports = new Set<string>();
  for (const m of content.matchAll(/import\s+(?:[^'\"]+\s+from\s+)?["']([^"']+)["']/g)) imports.add(compactText(redactSecrets(m[1]!), 240));
  for (const m of content.matchAll(/require\(["']([^"']+)["']\)/g)) imports.add(compactText(redactSecrets(m[1]!), 240));
  for (const m of content.matchAll(/^\s*from\s+([\w.]+)\s+import\s+/gm)) imports.add(compactText(redactSecrets(m[1]!), 240));
  return [...imports].slice(0, 40);
}

function fileKind(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return "typescript/javascript";
  if (["py"].includes(ext)) return "python";
  if (["rs"].includes(ext)) return "rust";
  if (["go"].includes(ext)) return "go";
  if (["md", "mdx"].includes(ext)) return "markdown";
  if (["json", "jsonc"].includes(ext)) return "json";
  return ext || "file";
}

function gitListFiles(root: string, args: string[]) {
  return execFileSync("git", ["-C", root, ...args, "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    .split("\0")
    .filter(Boolean);
}

function readTextWindow(file: string, start: number, maxBytes: number) {
  if (maxBytes <= 0) return "";
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(maxBytes);
    const bytes = readSync(fd, buffer, 0, maxBytes, Math.max(0, start));
    return buffer.subarray(0, bytes).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore close errors */ }
    }
  }
}

function readRepoMapContent(file: string, size: number, maxBytes: number) {
  if (maxBytes <= 0) return "";
  if (size <= maxBytes) {
    try { return readFileSync(file, "utf8"); } catch { return ""; }
  }
  const windowBytes = Math.max(1024, Math.floor(maxBytes / 3));
  const boundaryPadding = Math.min(2048, Math.max(256, Math.floor(windowBytes / 8)));
  const rawRanges = [0, Math.floor((size - windowBytes) / 2), size - windowBytes]
    .map((start) => ({ start: Math.max(0, start - boundaryPadding), end: Math.min(size, Math.max(0, start) + windowBytes + boundaryPadding) }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const range of rawRanges) {
    const previous = ranges.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else ranges.push({ ...range });
  }
  return ranges
    .map((range, index) => `${index ? "\n\n/* repo map: omitted middle of large file */\n\n" : ""}${readTextWindow(file, range.start, range.end - range.start)}`)
    .join("");
}

function isRepoMappableFile(path: string) {
  return !isSensitivePath(path)
    && !isNoisyRepoPath(path)
    && !path.includes("node_modules/")
    && !path.includes(".git/")
    && !path.startsWith(".pi/")
    && !/\.(png|jpg|jpeg|gif|webp|pdf|zip|tar|gz|sqlite|db|lock)$/i.test(path);
}

function listRepoFiles(root: string, walkFallbackLimit = DEFAULT_REPO_MAP_WALK_FALLBACK_LIMIT): string[] {
  try {
    const tracked = gitListFiles(root, ["ls-files"]);
    const untracked = gitListFiles(root, ["ls-files", "--others", "--exclude-standard"]);
    return [...new Set([...tracked, ...untracked])];
  } catch {
    const out: string[] = [];
    const visited = new Set<string>();
    const ignored = new Set([".git", "node_modules", "dist", "build", ".pi", "target", ".venv", "venv", ...REPO_NOISE_TOP_LEVEL]);
    function walk(dir: string) {
      if (out.length >= walkFallbackLimit) return;
      let directory;
      try { directory = lstatSync(dir); } catch { return; }
      if (directory.isSymbolicLink() || !directory.isDirectory()) return;
      const identity = `${directory.dev}:${directory.ino}`;
      if (visited.has(identity)) return;
      visited.add(identity);
      let names: string[];
      try { names = readdirSync(dir); } catch { return; }
      for (const name of names) {
        if (out.length >= walkFallbackLimit) return;
        if (ignored.has(name)) continue;
        const p = join(dir, name);
        let s;
        try { s = lstatSync(p); } catch { continue; }
        if (s.isSymbolicLink()) continue;
        if (s.isDirectory()) walk(p);
        else if (s.isFile()) out.push(relative(root, p));
      }
    }
    walk(root);
    return out;
  }
}

export function createRepoSnapshot(cwd: string, config = hybridMemoryConfig(cwd)): RepoSnapshot {
  const root = findProjectRoot(cwd);
  const discovered = listRepoFiles(root, config.repoMapWalkFallbackLimit)
    .filter((path) => isRepoMappableFile(path) && !isHomeRepoNoise(root, path))
    .flatMap((path) => {
      const file = safeRepoFile(root, path);
      return file ? [{ path, file }] : [];
    });
  return { root, files: discovered.slice(0, config.repoMapFileLimit), totalFiles: discovered.length };
}

export function buildRepoMap(cwd: string, config = hybridMemoryConfig(cwd), snapshot = createRepoSnapshot(cwd, config)): RepoMap {
  const root = snapshot.root;
  const files = snapshot.files.map(({ path, file }) => {
      const content = readRepoMapContent(file.absolutePath, file.size, config.repoMapReadMaxBytes);
      return { path, kind: fileKind(path), ...extractRepoDetails(path, content), imports: extractImports(content), size: file.size };
    });
  const map: RepoMap = { schemaVersion: 1, root, generatedAt: nowIso(), files };
  const dir = projectMemoryDir(cwd);
  initializeDir(dir, "project");
  atomicWriteFileSync(join(dir, REPOMAP), JSON.stringify(map, null, 2) + "\n");
  invalidateRepoMapStaleness(cwd);
  regenerateProjectContext(cwd, map, { stale: false, reason: "fresh" });
  return map;
}

export function readRepoMap(cwd: string): RepoMap | undefined {
  const file = join(projectMemoryDir(cwd), REPOMAP);
  if (!existsSync(file)) return undefined;
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > REPO_MAP_CACHE_MAX_BYTES) return undefined;
    const cached = repoMapFileCache.get(file);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.map;
    const map = normalizeRepoMap(JSON.parse(readFileSync(file, "utf8")));
    repoMapFileCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, map });
    return map;
  } catch {
    repoMapFileCache.delete(file);
    return undefined;
  }
}

export function repoMapStaleness(cwd: string, map = readRepoMap(cwd), config = hybridMemoryConfig(cwd), snapshot = createRepoSnapshot(cwd, config)): RepoMapStaleness {
  if (!map) return { stale: true, reason: "missing repo map" };
  const generated = Date.parse(map.generatedAt);
  if (!Number.isFinite(generated)) return { stale: true, reason: "invalid generatedAt" };
  const root = snapshot.root;
  if (resolve(map.root) !== resolve(root)) return { stale: true, reason: "repo map belongs to a different project root" };
  const mapped = new Set(map.files.map((f) => f.path));
  const current = snapshot.files.map(({ path }) => path);
  for (const path of current) {
    if (!mapped.has(path)) return { stale: true, reason: `${path} added after repo map generation` };
  }
  let newest = 0;
  let newestPath = "";
  for (const f of map.files) {
    const file = safeRepoFile(root, f.path);
    if (!file) return { stale: true, reason: `${f.path} is missing or no longer a safe regular file` };
    const mtime = file.mtimeMs;
    if (mtime > newest) { newest = mtime; newestPath = f.path; }
  }
  return newest > generated + 1000 ? { stale: true, reason: `${newestPath} changed after repo map generation` } : { stale: false, reason: "fresh" };
}

function invalidateRepoMapStaleness(cwd: string) {
  repoStalenessCache.delete(findProjectRoot(cwd));
  repoMapFileCache.delete(join(projectMemoryDir(cwd), REPOMAP));
}

export function repoMapStalenessCached(cwd: string, ttlMs = REPO_STALENESS_CACHE_TTL_MS, map = readRepoMap(cwd)): RepoMapStaleness {
  const key = findProjectRoot(cwd);
  const cached = repoStalenessCache.get(key);
  if (cached && cached.mapGeneratedAt === map?.generatedAt && Date.now() - cached.checkedAt < ttlMs) return cached.result;
  const result = repoMapStaleness(cwd, map);
  repoStalenessCache.set(key, { checkedAt: Date.now(), mapGeneratedAt: map?.generatedAt, result });
  return result;
}

export function regenerateProjectContext(cwd: string, map = readRepoMap(cwd), repoStatus?: RepoMapStaleness) {
  const dir = projectMemoryDir(cwd);
  initializeDir(dir, "project");
  const records = activeRecords(latestRecordsForCwd(cwd));
  const project = records.filter((r) => r.scope === "project");
  const prefs = records.filter((r) => r.scope === "user" && r.kind === "preference").slice(0, 8);
  const globalDecisions = records.filter((r) => r.scope === "user" && ["decision", "project_fact"].includes(r.kind)).slice(0, 8);
  const decisions = project.filter((r) => ["decision", "project_fact"].includes(r.kind));
  const work = records.filter((r) => r.kind === "work_item");
  const updatedAt = nowIso();
  const lines = ["# Hybrid Memory Working Context", "", `Updated: ${updatedAt}`, ""];
  if (prefs.length) { lines.push("## User preferences"); for (const r of prefs) lines.push(`- ${redactSecrets(r.content)}`); lines.push(""); }
  if (globalDecisions.length) { lines.push("## Global decisions/facts"); for (const r of globalDecisions) lines.push(`- ${redactSecrets(r.content)}`); lines.push(""); }
  if (decisions.length) { lines.push("## Project decisions/facts"); for (const r of decisions) lines.push(`- ${redactSecrets(r.content)}`); lines.push(""); }
  if (work.length) { lines.push("## Active work"); for (const r of work) lines.push(`- ${r.id}: ${redactSecrets(r.content)}`); lines.push(""); }
  if (map) {
    const stale = repoStatus ?? repoMapStalenessCached(cwd, REPO_STALENESS_CACHE_TTL_MS, map);
    lines.push("## Repo map", `- Root: ${map.root}`, `- Files: ${map.files.length}`, `- Status: ${stale.stale ? `stale (${stale.reason})` : "fresh"}`);
    const rich = map.files.filter((f) => !isSensitivePath(f.path) && (f.commands?.length || f.tools?.length || f.hooks?.length || displayRepoSymbols(f.symbols, 1).length)).slice(0, 12);
    for (const f of rich) {
      const symbols = displayRepoSymbols(f.symbols, 16);
      const bits = [
        f.commands?.length ? `commands: ${f.commands.map(redactSecrets).join(", ")}` : "",
        f.tools?.length ? `tools: ${f.tools.map(redactSecrets).join(", ")}` : "",
        f.hooks?.length ? `hooks: ${f.hooks.map(redactSecrets).join(", ")}` : "",
        symbols.length ? `symbols: ${symbols.join(", ")}` : "",
      ].filter(Boolean).join("; ");
      lines.push(`- ${f.path}${bits ? ` — ${bits}` : ""}`);
    }
    lines.push("");
  }
  atomicWriteFileSync(join(dir, ACTIVE), JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    updatedAt,
    activeWork: work.map((r) => ({
      id: recordKey(r),
      subject: redactSecrets(r.subject),
      content: redactSecrets(r.content),
      filePaths: sanitizeFilePaths(r.filePaths) ?? [],
      salience: r.salience,
      pinned: Boolean(r.pinned),
      updatedAt: r.updatedAt,
    })),
  }, null, 2) + "\n");
  atomicWriteFileSync(join(dir, CONTEXT), lines.join("\n") + "\n");
}

setProjectContextRegenerator(regenerateProjectContext);

function repoFileMatch(f: RepoMapFile, terms: string[], distinctiveTerms: string[], automatic: boolean, autoInjectMinDistinctiveTerms: number) {
  const searchable = [f.path, f.kind, ...f.symbols, ...f.imports, ...(f.commands ?? []), ...(f.tools ?? []), ...(f.hooks ?? []), ...(f.exports ?? [])].join(" ").toLowerCase();
  const symbolish = [...f.symbols, ...(f.commands ?? []), ...(f.tools ?? []), ...(f.hooks ?? []), ...(f.exports ?? [])].map((x) => x.toLowerCase());
  let score = 0;
  let pathLikeMatch = false;
  let exactSymbolMatch = false;
  const distinctiveMatches = new Set<string>();
  for (const t of terms) {
    const variants = searchTermVariants(t);
    const matched = variants.some((variant) => searchable.includes(variant));
    if (!matched) continue;
    const weight = t.includes("/") || t.includes(".") ? 5 : searchTermWeight(t);
    score += Math.max(1, weight);
    if (variants.some((variant) => /[./:_-]/.test(t) && f.path.toLowerCase().includes(variant))) pathLikeMatch = true;
    if (variants.some((variant) => symbolish.some((s) => s === variant))) exactSymbolMatch = true;
    if (distinctiveTerms.includes(t.replace(/^[@\-./:]+|[@\-./:]+$/g, ""))) distinctiveMatches.add(t);
  }
  if (!automatic) return { f, score, eligible: score > 0 };
  const eligible = score > 0 && (pathLikeMatch || exactSymbolMatch || distinctiveMatches.size >= autoInjectMinDistinctiveTerms);
  return { f, score, eligible };
}

export function repoExcerpt(cwd: string, query: string, map = readRepoMap(cwd), automatic = false, config = hybridMemoryConfig(cwd)) {
  if (!map) return "";
  const safeQuery = redactSecrets(query);
  const terms = [...new Set(tokenize(safeQuery).flatMap(searchTermVariants).filter((t) => searchTermWeight(t) > 0))];
  const distinctiveTerms = distinctiveQueryTerms(safeQuery);
  const ranked = map.files
    .filter((f) => !isSensitivePath(f.path))
    .map((f) => repoFileMatch(f, terms, distinctiveTerms, automatic, config.repoMapAutoInjectMinDistinctiveTerms))
    .filter((x) => x.eligible && x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  if (!ranked.length) return "";
  return ranked.map(({ f }) => {
    const symbols = displayRepoSymbols(f.symbols, 8);
    const bits = [
      f.commands?.length ? `commands: ${f.commands.slice(0, 6).map(redactSecrets).join(", ")}` : "",
      f.tools?.length ? `tools: ${f.tools.slice(0, 6).map(redactSecrets).join(", ")}` : "",
      f.hooks?.length ? `hooks: ${f.hooks.slice(0, 6).map(redactSecrets).join(", ")}` : "",
      symbols.length ? `symbols: ${symbols.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    return `- ${f.path}${bits ? ` — ${bits}` : ""}`;
  }).join("\n");
}
