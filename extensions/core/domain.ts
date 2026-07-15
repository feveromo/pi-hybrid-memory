export const SCHEMA_VERSION = 1 as const;

export const kindEnum = ["preference", "decision", "project_fact", "codebase_note", "recipe", "work_item", "session_recap"] as const;
export const scopeEnum = ["user", "project"] as const;
export const statusEnum = ["active", "done", "superseded", "stale"] as const;
export const searchStatusEnum = ["active", "done", "superseded", "stale", "all"] as const;
export const doctorModeEnum = ["preview", "apply"] as const;

export type MemoryKind = typeof kindEnum[number];
export type MemoryScope = typeof scopeEnum[number];
export type MemoryStatus = typeof statusEnum[number];

export type MemoryRecord = {
  id: string;
  schemaVersion: typeof SCHEMA_VERSION;
  scope: MemoryScope;
  kind: MemoryKind;
  subject: string;
  content: string;
  tags: string[];
  filePaths?: string[];
  symbols?: string[];
  status?: MemoryStatus;
  salience: 1 | 2 | 3 | 4 | 5;
  pinned?: boolean;
  evidence?: Record<string, unknown>;
  supersedes?: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
};

export type RepoMapFile = {
  path: string;
  kind: string;
  symbols: string[];
  imports: string[];
  commands?: string[];
  tools?: string[];
  hooks?: string[];
  exports?: string[];
  size: number;
};

export type RepoMap = {
  schemaVersion: typeof SCHEMA_VERSION;
  root: string;
  generatedAt: string;
  files: RepoMapFile[];
};

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isMemoryKind(value: unknown): value is MemoryKind {
  return kindEnum.includes(value as MemoryKind);
}

export function isMemoryScope(value: unknown): value is MemoryScope {
  return scopeEnum.includes(value as MemoryScope);
}

export function isMemoryStatus(value: unknown): value is MemoryStatus {
  return statusEnum.includes(value as MemoryStatus);
}
