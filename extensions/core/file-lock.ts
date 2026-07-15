import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

type LockOwner = {
  token: string;
  pid: number;
  createdAt: number;
};

export type FileLockOptions = {
  timeoutMs?: number;
  staleMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
};

const DEFAULT_LOCK_OPTIONS: Required<FileLockOptions> = {
  timeoutMs: 15_000,
  staleMs: 5 * 60_000,
  retryMinMs: 8,
  retryMaxMs: 32,
};

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readOwner(lockDir: string): LockOwner | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(`${lockDir}/owner.json`, "utf8"));
    if (!value || typeof value !== "object") return undefined;
    const owner = value as Partial<LockOwner>;
    if (typeof owner.token !== "string" || typeof owner.pid !== "number" || typeof owner.createdAt !== "number") return undefined;
    return owner as LockOwner;
  } catch {
    return undefined;
  }
}

function recoverAbandonedLock(lockDir: string, staleMs: number) {
  try {
    const age = Date.now() - statSync(lockDir).mtimeMs;
    if (age < staleMs) return false;
    const owner = readOwner(lockDir);
    if (owner && processIsAlive(owner.pid)) return false;
    rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(lockDir: string, options: Required<FileLockOptions>) {
  mkdirSync(dirname(lockDir), { recursive: true, mode: 0o700 });
  const owner: LockOwner = { token: randomUUID(), pid: process.pid, createdAt: Date.now() };
  const deadline = Date.now() + options.timeoutMs;
  while (true) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      writeFileSync(`${lockDir}/owner.json`, JSON.stringify(owner) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
      return owner;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        // If owner creation failed after mkdir succeeded, do not strand a lock.
        const current = readOwner(lockDir);
        if (!current) rmSync(lockDir, { recursive: true, force: true });
        throw error;
      }
      if (recoverAbandonedLock(lockDir, options.staleMs)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for hybrid-memory lock: ${lockDir}`);
      const spread = Math.max(0, options.retryMaxMs - options.retryMinMs);
      await delay(options.retryMinMs + Math.floor(Math.random() * (spread + 1)));
    }
  }
}

function releaseLock(lockDir: string, owner: LockOwner) {
  const current = readOwner(lockDir);
  if (current?.token !== owner.token) return;
  rmSync(lockDir, { recursive: true, force: true });
}

/**
 * Serialize mutations across Pi processes. Paths are sorted before acquisition,
 * so operations touching user and project stores cannot deadlock each other.
 */
export async function withCrossProcessFileLocks<T>(
  files: readonly string[],
  fn: () => T | Promise<T>,
  overrides: FileLockOptions = {},
): Promise<T> {
  const options = { ...DEFAULT_LOCK_OPTIONS, ...overrides };
  const lockDirs = [...new Set(files.map((file) => `${file}.lock`))].sort();
  const acquired: Array<{ lockDir: string; owner: LockOwner }> = [];
  try {
    for (const lockDir of lockDirs) acquired.push({ lockDir, owner: await acquireLock(lockDir, options) });
    return await fn();
  } finally {
    for (const lock of acquired.reverse()) releaseLock(lock.lockDir, lock.owner);
  }
}
