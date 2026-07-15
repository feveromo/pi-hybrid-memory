import { homedir } from "node:os";
import { resolve } from "node:path";
import { boundedStrings, MEMORY_LIMITS, truncateText } from "./limits.ts";
import { isMemoryKind, isMemoryScope, isMemoryStatus, isPlainObject, SCHEMA_VERSION, type MemoryRecord } from "./domain.ts";

export const SECRET_REPLACEMENT = "[REDACTED]";
export const REPO_NOISE_TOP_LEVEL = new Set([
  ".android", ".cache", ".cargo", ".config", ".dotnet", ".gradle", ".java", ".local", ".npm", ".nv", ".openclaw", ".pytest_cache", ".rustup", ".thinkorswim", ".vscode", ".vscode-shared", ".warp",
  "Android", "Applications", "Desktop", "Documents", "Downloads", "Games", "Models", "Music", "Pictures", "Public", "Templates", "Videos", "snap", "thinkorswim",
]);
const HOME_REPO_NOISE_TOP_LEVEL = new Set([...REPO_NOISE_TOP_LEVEL, "Dev", "go", "node_modules", "pi-memory-backups"]);

export function isSensitivePath(value: string): boolean {
  const path = value.replace(/\\/g, "/").toLowerCase();
  return /(^|\/)\.env(?:$|[./-])/.test(path)
    || /(^|\/)(?:\.[a-z0-9_-]*history|\.npmrc|\.netrc|\.emulator_console_auth_token)$/.test(path)
    || /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519|adbkey)(?:\.pub)?$/.test(path)
    || /\.(pem|key|p12|pfx|kdbx)$/i.test(path)
    || /(^|\/)(secrets?|credentials?|private-key|api-key|tokens?)(?:[./-]|$)/.test(path)
    || /(^|\/)\.(aws|azure|config\/gcloud)\/credentials(?:$|[./-])/.test(path);
}

export function isNoisyRepoPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const top = parts[0] ?? "";
  return REPO_NOISE_TOP_LEVEL.has(top)
    || parts.includes("__pycache__")
    || parts.includes("node_modules")
    || parts.includes(".git")
    || /(^|\/)\.DS_Store$/.test(normalized)
    || /\.(?:avd|bin|class|dll|dmg|exe|img|iso|o|pyc|qcow2|so|tmp)$/i.test(normalized);
}

export function isHomeRepoNoise(root: string, path: string): boolean {
  if (resolve(root) !== homedir()) return false;
  const top = path.replace(/\\/g, "/").split("/").filter(Boolean)[0] ?? "";
  return HOME_REPO_NOISE_TOP_LEVEL.has(top) || (top.startsWith(".") && path.includes("/") && top !== ".agents");
}

export function redactSecrets(text: string): string {
  let out = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  out = out.replace(/-----BEGIN [^-]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)[\s\S]*?-----END [^-]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----/gi, "[REDACTED PRIVATE KEY]");
  out = out.replace(/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|npm_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16})\b/g, SECRET_REPLACEMENT);
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, `$1 ${SECRET_REPLACEMENT}`);
  out = out.replace(/((?:api[_ -]?key|secret|token|password|passwd|pwd|authorization|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|private[_ -]?key)\s*[:=]\s*)(["']?)[^\s"'`]{6,}\2/gi, `$1$2${SECRET_REPLACEMENT}$2`);
  out = out.replace(/((?:api key|password|secret|token)\s+(?:is|was)\s+)(["']?)[^\s"'`]{6,}\2/gi, `$1$2${SECRET_REPLACEMENT}$2`);
  out = out.replace(/\S*(?:(?:^|\s)\.env(?=$|[\s./-])|\/\.env(?=$|[\s./-])|\/(?:\.[a-z0-9_-]*history|\.npmrc|\.netrc|\.emulator_console_auth_token)|\/(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|adbkey)(?:\.pub)?|\.(?:pem|key|p12|pfx|kdbx))\S*/gi, "[REDACTED_PATH]");
  return out.replace(/<\/?hybrid_memory>/gi, "[redacted-hybrid-memory-tag]");
}

export function redactJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[omitted]";
  if (typeof value === "string") return truncateText(isSensitivePath(value) ? "[REDACTED_PATH]" : redactSecrets(value), MEMORY_LIMITS.evidenceString);
  if (Array.isArray(value)) return value.slice(0, MEMORY_LIMITS.evidenceEntries).map((item) => redactJsonValue(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MEMORY_LIMITS.evidenceEntries)) {
      out[key] = /secret|token|password|passwd|api[_-]?key|authorization|private[_-]?key/i.test(key)
        ? SECRET_REPLACEMENT
        : redactJsonValue(item, depth + 1);
    }
    return out;
  }
  return value;
}

export function sanitizeFilePaths(filePaths?: string[]): string[] | undefined {
  return boundedStrings(filePaths?.filter((path) => typeof path === "string" && !isSensitivePath(path)).map((path) => redactSecrets(path)), MEMORY_LIMITS.filePathCount, MEMORY_LIMITS.filePath);
}

export function isMemoryArtifactPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith(".pi/hybrid-memory/")
    || normalized.includes("/.pi/hybrid-memory/")
    || normalized.includes("/sessions/")
    || normalized.includes("/chain-runs/")
    || normalized.includes("/pi-subagent")
    || /(?:^|\/)(?:progress|research|plan)\.md$/i.test(normalized);
}

export function sanitizeRecordForStorage(record: MemoryRecord): MemoryRecord {
  return {
    ...record,
    subject: truncateText(redactSecrets(record.subject).trim() || record.kind, MEMORY_LIMITS.subject),
    content: truncateText(redactSecrets(record.content).trim() || SECRET_REPLACEMENT, MEMORY_LIMITS.content),
    tags: boundedStrings((record.tags ?? []).map((tag) => redactSecrets(tag)).filter(Boolean), MEMORY_LIMITS.tagCount, MEMORY_LIMITS.tag) ?? [],
    filePaths: sanitizeFilePaths(record.filePaths),
    symbols: boundedStrings(record.symbols?.map((symbol) => redactSecrets(symbol)).filter(Boolean), MEMORY_LIMITS.symbolCount, MEMORY_LIMITS.symbol),
    evidence: record.evidence ? redactJsonValue(record.evidence) as Record<string, unknown> : undefined,
    supersedes: boundedStrings(record.supersedes, MEMORY_LIMITS.supersedesCount, MEMORY_LIMITS.id),
  };
}

export function normalizeMemoryRecord(value: unknown, now = new Date().toISOString()): MemoryRecord | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.schemaVersion !== SCHEMA_VERSION || typeof value.id !== "string" || !value.id.trim() || value.id.length > MEMORY_LIMITS.id) return undefined;
  if (!isMemoryScope(value.scope) || !isMemoryKind(value.kind)) return undefined;
  const content = typeof value.content === "string" ? value.content.trim() : "";
  if (!content) return undefined;
  const subject = typeof value.subject === "string" && value.subject.trim() ? value.subject.trim() : value.kind;
  const status = value.status === undefined ? "active" : isMemoryStatus(value.status) ? value.status : "active";
  const salience = Math.max(1, Math.min(5, Math.round(typeof value.salience === "number" ? value.salience : 3))) as 1 | 2 | 3 | 4 | 5;
  const createdAt = typeof value.createdAt === "string" && value.createdAt ? value.createdAt : now;
  const updatedAt = typeof value.updatedAt === "string" && value.updatedAt ? value.updatedAt : createdAt;
  return sanitizeRecordForStorage({
    id: value.id,
    schemaVersion: SCHEMA_VERSION,
    scope: value.scope,
    kind: value.kind,
    subject,
    content,
    tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : [],
    filePaths: Array.isArray(value.filePaths) ? value.filePaths.filter((file): file is string => typeof file === "string") : undefined,
    symbols: Array.isArray(value.symbols) ? value.symbols.filter((symbol): symbol is string => typeof symbol === "string") : undefined,
    status,
    salience,
    pinned: typeof value.pinned === "boolean" ? value.pinned : undefined,
    evidence: isPlainObject(value.evidence) ? value.evidence : undefined,
    supersedes: Array.isArray(value.supersedes) ? value.supersedes.filter((id): id is string => typeof id === "string") : undefined,
    createdAt,
    updatedAt,
    lastUsedAt: typeof value.lastUsedAt === "string" ? value.lastUsedAt : undefined,
    expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : undefined,
  });
}
