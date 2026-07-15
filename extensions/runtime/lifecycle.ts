import { existsSync, statSync } from "node:fs";

import { SESSION_IMPORT_MAX_BYTES, nowIso, updateProjectState } from "./foundation.ts";
import { hybridMemoryConfig } from "./configuration.ts";
import { createRepoSnapshot, buildRepoMap, readRepoMap, repoMapStaleness, regenerateProjectContext } from "./repo-context.ts";
import { listProjectSessionFilesCheap, listSessionFiles, importSessions } from "./sessions.ts";
import { pruneMemory, type PruneResult } from "./curation.ts";

export type BootstrapResult = { repoFiles: number; sessions: ReturnType<typeof importSessions>; prune: PruneResult; scannedAvailable: number };

export function autoImportCurrentSession(cwd: string, sessionFile?: string) {
  if (!sessionFile || !existsSync(sessionFile)) return { scanned: 0, extracted: 0, written: 0, sessionFiles: [] as string[] };
  try {
    if (statSync(sessionFile).size > SESSION_IMPORT_MAX_BYTES) return { scanned: 0, extracted: 0, written: 0, sessionFiles: [sessionFile] };
    const result = importSessions(cwd, [sessionFile], { includeCommandRecipes: false });
    pruneMemory(cwd, hybridMemoryConfig(cwd).autoPruneActiveSessionRecaps);
    return result;
  } catch {
    return { scanned: 0, extracted: 0, written: 0, sessionFiles: [sessionFile] };
  }
}

function projectSessionFiles(cwd: string, limit = 250) {
  return listSessionFiles(limit, cwd);
}

export function bootstrapProjectMemory(cwd: string, maxSessions = 250): BootstrapResult {
  const config = hybridMemoryConfig(cwd);
  const map = buildRepoMap(cwd, config);
  const files = projectSessionFiles(cwd, maxSessions);
  const sessions = importSessions(cwd, files);
  const prune = pruneMemory(cwd, config.bootstrapPruneActiveSessionRecaps);
  updateProjectState(cwd, {
    bootstrappedAt: nowIso(),
    bootstrapSessionsScanned: sessions.scanned,
    bootstrapSessionsWritten: sessions.written,
    bootstrapRepoFiles: map.files.length,
  });
  return { repoFiles: map.files.length, sessions, prune, scannedAvailable: files.length };
}

export function cheapStartupRefresh(cwd: string, currentSession?: string) {
  const config = hybridMemoryConfig(cwd);
  const snapshot = createRepoSnapshot(cwd, config);
  const existingMap = readRepoMap(cwd);
  const stale = repoMapStaleness(cwd, existingMap, config, snapshot);
  let map = existingMap;
  let builtMap = false;
  if ((!existingMap || stale.stale) && snapshot.totalFiles <= config.startupRepoMapFileLimit) {
    map = buildRepoMap(cwd, config, snapshot);
    builtMap = true;
  } else {
    regenerateProjectContext(cwd, map, stale);
  }

  const files = [...new Set([...(currentSession ? [currentSession] : []), ...listProjectSessionFilesCheap(cwd, 2)])]
    .filter((f) => existsSync(f) && statSync(f).size <= SESSION_IMPORT_MAX_BYTES);
  const currentFiles = currentSession ? files.filter((f) => f === currentSession) : [];
  const recentFiles = currentSession ? files.filter((f) => f !== currentSession) : files;
  const currentSessions = importSessions(cwd, currentFiles, { includeCommandRecipes: false });
  const recentSessions = importSessions(cwd, recentFiles);
  const sessions = {
    scanned: currentSessions.scanned + recentSessions.scanned,
    extracted: currentSessions.extracted + recentSessions.extracted,
    written: currentSessions.written + recentSessions.written,
    sessionFiles: [...currentSessions.sessionFiles, ...recentSessions.sessionFiles],
  };
  const prune = pruneMemory(cwd, config.autoPruneActiveSessionRecaps);
  updateProjectState(cwd, {
    lastStartupRefreshAt: nowIso(),
    lastStartupBuiltRepoMap: builtMap,
    lastStartupRepoFileCount: snapshot.totalFiles,
    lastStartupSessionsScanned: sessions.scanned,
    lastStartupSessionsWritten: sessions.written,
    lastStartupPruned: prune.staleMarked,
  });
  return { builtMap, repoFiles: map?.files.length ?? snapshot.totalFiles, sessions, skippedRepoMap: !builtMap && (!existingMap || stale.stale) };
}
