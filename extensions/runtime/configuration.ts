import { type AgentToolResult } from "@earendil-works/pi-coding-agent";

import { chmodSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../core/atomic-file.ts";
import { isPlainObject } from "../core/domain.ts";
import { cleanArgToken } from "../core/text.ts";
import { DEFAULT_REPO_MAP_WALK_FALLBACK_LIMIT, ensureDir, findProjectRoot } from "./foundation.ts";

const MAX_INJECT_CHARS = 4200;
const INJECT_SECTION_LIMITS: Record<string, number> = {
  "User Preferences": 5,
  "Global Decisions/Facts": 3,
  "Project Decisions": 5,
  "Active Work": 5,
  "Recipes": 3,
  "Relevant Session Recaps": 2,
  "Relevant Codebase Notes": 4,
};
const DEFAULT_REPO_MAP_FILE_LIMIT = 1500;
const DEFAULT_REPO_MAP_READ_MAX_BYTES = 200_000;
const DEFAULT_STARTUP_REPO_MAP_FILE_LIMIT = 500;
const DEFAULT_REPO_MAP_AUTO_INJECT_MIN_DISTINCTIVE_TERMS = 2;
const DEFAULT_PRUNE_ACTIVE_SESSION_RECAPS = 12;
const DEFAULT_AUTO_PRUNE_ACTIVE_SESSION_RECAPS = 8;
const DEFAULT_AUTO_CAPTURE_PREFERENCES: AutoCapturePreferenceMode = "explicit";
const DEFAULT_AUTO_CAPTURE_MAX_CHARS = 240;

export type AutoCapturePreferenceMode = "off" | "explicit" | "heuristic";

export type HybridMemoryConfig = {
  enabled: boolean;
  maxInjectChars: number;
  injectSectionLimits: Record<string, number>;
  repoMapFileLimit: number;
  repoMapReadMaxBytes: number;
  repoMapWalkFallbackLimit: number;
  startupRepoMapFileLimit: number;
  repoMapAutoInjectMinDistinctiveTerms: number;
  pruneActiveSessionRecaps: number;
  autoPruneActiveSessionRecaps: number;
  bootstrapPruneActiveSessionRecaps: number;
  staleCodebaseNotesOnFileChange: boolean;
  autoCapturePreferences: AutoCapturePreferenceMode;
  autoCaptureMaxChars: number;
};

type SettingsFileCacheEntry = {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  settings?: Record<string, unknown>;
};

const DEFAULT_HYBRID_MEMORY_CONFIG: HybridMemoryConfig = {
  enabled: true,
  maxInjectChars: MAX_INJECT_CHARS,
  injectSectionLimits: { ...INJECT_SECTION_LIMITS },
  repoMapFileLimit: DEFAULT_REPO_MAP_FILE_LIMIT,
  repoMapReadMaxBytes: DEFAULT_REPO_MAP_READ_MAX_BYTES,
  repoMapWalkFallbackLimit: DEFAULT_REPO_MAP_WALK_FALLBACK_LIMIT,
  startupRepoMapFileLimit: DEFAULT_STARTUP_REPO_MAP_FILE_LIMIT,
  repoMapAutoInjectMinDistinctiveTerms: DEFAULT_REPO_MAP_AUTO_INJECT_MIN_DISTINCTIVE_TERMS,
  pruneActiveSessionRecaps: DEFAULT_PRUNE_ACTIVE_SESSION_RECAPS,
  autoPruneActiveSessionRecaps: DEFAULT_AUTO_PRUNE_ACTIVE_SESSION_RECAPS,
  bootstrapPruneActiveSessionRecaps: DEFAULT_PRUNE_ACTIVE_SESSION_RECAPS,
  staleCodebaseNotesOnFileChange: true,
  autoCapturePreferences: DEFAULT_AUTO_CAPTURE_PREFERENCES,
  autoCaptureMaxChars: DEFAULT_AUTO_CAPTURE_MAX_CHARS,
};

const settingsFileCache = new Map<string, SettingsFileCacheEntry>();

function clampSetting(value: unknown, fallback: number, min: number, max: number) {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

function readSettingsObject(file: string): Record<string, unknown> | undefined {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 1_000_000) {
      settingsFileCache.delete(file);
      return undefined;
    }
    const cached = settingsFileCache.get(file);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs) return cached.settings;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const settings = isPlainObject(parsed) ? parsed : undefined;
    settingsFileCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, settings });
    if (settingsFileCache.size > 64) settingsFileCache.delete(settingsFileCache.keys().next().value!);
    return settings;
  } catch {
    settingsFileCache.delete(file);
    return undefined;
  }
}

function mergeHybridMemoryConfig(base: HybridMemoryConfig, raw: unknown): HybridMemoryConfig {
  const config: HybridMemoryConfig = { ...base, injectSectionLimits: { ...base.injectSectionLimits } };
  if (!isPlainObject(raw)) return config;

  const repoMap: Record<string, unknown> = isPlainObject(raw.repoMap) ? raw.repoMap : {};
  const prune: Record<string, unknown> = isPlainObject(raw.prune) ? raw.prune : {};
  const compaction: Record<string, unknown> = isPlainObject(raw.compaction) ? raw.compaction : {};
  const autoCapture: Record<string, unknown> = isPlainObject(raw.autoCapture) ? raw.autoCapture : {};
  if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
  if (typeof raw.disabled === "boolean") config.enabled = !raw.disabled;
  config.maxInjectChars = clampSetting(raw.maxInjectChars, config.maxInjectChars, 1000, 30_000);
  config.repoMapFileLimit = clampSetting(raw.repoMapFileLimit ?? repoMap.fileLimit, config.repoMapFileLimit, 100, 20_000);
  config.repoMapReadMaxBytes = clampSetting(raw.repoMapReadMaxBytes ?? repoMap.readMaxBytes, config.repoMapReadMaxBytes, 16_000, 2_000_000);
  config.repoMapWalkFallbackLimit = clampSetting(raw.repoMapWalkFallbackLimit ?? repoMap.walkFallbackLimit, config.repoMapWalkFallbackLimit, 100, 50_000);
  config.startupRepoMapFileLimit = clampSetting(raw.startupRepoMapFileLimit ?? repoMap.startupFileLimit, config.startupRepoMapFileLimit, 0, 5000);
  config.repoMapAutoInjectMinDistinctiveTerms = clampSetting(raw.repoMapAutoInjectMinDistinctiveTerms ?? repoMap.autoInjectMinDistinctiveTerms, config.repoMapAutoInjectMinDistinctiveTerms, 1, 6);
  config.pruneActiveSessionRecaps = clampSetting(raw.pruneActiveSessionRecaps ?? prune.activeSessionRecaps, config.pruneActiveSessionRecaps, 3, 100);
  config.autoPruneActiveSessionRecaps = clampSetting(raw.autoPruneActiveSessionRecaps ?? prune.autoActiveSessionRecaps, config.autoPruneActiveSessionRecaps, 3, 100);
  config.bootstrapPruneActiveSessionRecaps = clampSetting(raw.bootstrapPruneActiveSessionRecaps ?? prune.bootstrapActiveSessionRecaps, config.bootstrapPruneActiveSessionRecaps, 3, 100);
  const staleCodebaseNotesOnFileChange = raw.staleCodebaseNotesOnFileChange ?? compaction.staleCodebaseNotesOnFileChange;
  if (typeof staleCodebaseNotesOnFileChange === "boolean") config.staleCodebaseNotesOnFileChange = staleCodebaseNotesOnFileChange;
  const autoCapturePreferences = raw.autoCapturePreferences ?? autoCapture.preferences;
  if (autoCapturePreferences === "off" || autoCapturePreferences === "explicit" || autoCapturePreferences === "heuristic") config.autoCapturePreferences = autoCapturePreferences;
  config.autoCaptureMaxChars = clampSetting(raw.autoCaptureMaxChars ?? autoCapture.maxChars, config.autoCaptureMaxChars, 80, 1000);

  const sectionLimits = raw.injectSectionLimits ?? raw.sectionLimits;
  if (isPlainObject(sectionLimits)) {
    for (const [title, fallback] of Object.entries(INJECT_SECTION_LIMITS)) {
      if (Object.prototype.hasOwnProperty.call(sectionLimits, title)) config.injectSectionLimits[title] = clampSetting(sectionLimits[title], fallback, 0, 20);
    }
  }
  return config;
}

export function hybridMemoryConfig(cwd: string): HybridMemoryConfig {
  let config: HybridMemoryConfig = { ...DEFAULT_HYBRID_MEMORY_CONFIG, injectSectionLimits: { ...DEFAULT_HYBRID_MEMORY_CONFIG.injectSectionLimits } };
  for (const file of [join(homedir(), ".pi", "agent", "settings.json"), join(findProjectRoot(cwd), ".pi", "settings.json")]) {
    const settings = readSettingsObject(file);
    const raw = settings?.hybridMemory ?? settings?.["pi-hybrid-memory"] ?? settings?.hybrid_memory;
    config = mergeHybridMemoryConfig(config, raw);
  }
  return config;
}

export function publicHybridMemoryConfig(config: HybridMemoryConfig) {
  return {
    enabled: config.enabled,
    maxInjectChars: config.maxInjectChars,
    injectSectionLimits: config.injectSectionLimits,
    repoMapFileLimit: config.repoMapFileLimit,
    repoMapReadMaxBytes: config.repoMapReadMaxBytes,
    repoMapWalkFallbackLimit: config.repoMapWalkFallbackLimit,
    startupRepoMapFileLimit: config.startupRepoMapFileLimit,
    repoMapAutoInjectMinDistinctiveTerms: config.repoMapAutoInjectMinDistinctiveTerms,
    pruneActiveSessionRecaps: config.pruneActiveSessionRecaps,
    autoPruneActiveSessionRecaps: config.autoPruneActiveSessionRecaps,
    bootstrapPruneActiveSessionRecaps: config.bootstrapPruneActiveSessionRecaps,
    staleCodebaseNotesOnFileChange: config.staleCodebaseNotesOnFileChange,
    autoCapturePreferences: config.autoCapturePreferences,
    autoCaptureMaxChars: config.autoCaptureMaxChars,
  };
}

export function formatHybridMemoryConfig(cwd: string) {
  return JSON.stringify(publicHybridMemoryConfig(hybridMemoryConfig(cwd)), null, 2);
}

export function hybridMemoryEnabled(cwd: string) {
  return hybridMemoryConfig(cwd).enabled;
}

type HybridMemoryToggleTarget = "global" | "project";

function memoryToggleSettingsFile(cwd: string, target: HybridMemoryToggleTarget) {
  return target === "project"
    ? join(findProjectRoot(cwd), ".pi", "settings.json")
    : join(homedir(), ".pi", "agent", "settings.json");
}

export function setHybridMemoryEnabled(cwd: string, enabled: boolean, target: HybridMemoryToggleTarget) {
  const file = memoryToggleSettingsFile(cwd, target);
  const settings = readSettingsObject(file) ?? {};
  const existing = isPlainObject(settings.hybridMemory) ? settings.hybridMemory : {};
  settings.hybridMemory = { ...existing, enabled };
  ensureDir(dirname(file));
  atomicWriteFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  chmodSync(file, 0o600);
  settingsFileCache.delete(file);
  return file;
}

export function disabledHybridMemoryToolResult(cwd: string): AgentToolResult<{ disabled: true; config: Record<string, unknown> }> {
  return {
    content: [{ type: "text" as const, text: "Hybrid memory is disabled by settings. Stored JSONL data is unchanged. Use /hmemory-toggle on or set hybridMemory.enabled=true to re-enable it." }],
    details: { disabled: true, config: publicHybridMemoryConfig(hybridMemoryConfig(cwd)) },
  };
}

export function parseMemoryToggleArgs(args: string) {
  const tokens = args.match(/(?:"[^"]*"|'[^']*'|\S+)/g)?.map(cleanArgToken) ?? [];
  let target: HybridMemoryToggleTarget = "global";
  let enabled: boolean | undefined;
  let status = false;
  for (const token of tokens) {
    if (/^(?:--?project|project)$/i.test(token)) target = "project";
    else if (/^(?:--?global|global|user)$/i.test(token)) target = "global";
    else if (/^(?:on|enable|enabled|true|1)$/i.test(token)) enabled = true;
    else if (/^(?:off|disable|disabled|false|0)$/i.test(token)) enabled = false;
    else if (/^(?:status|show|check)$/i.test(token)) status = true;
  }
  return { target, enabled, status: status || enabled === undefined };
}

export function hybridMemoryToggleStatusText(cwd: string) {
  const config = publicHybridMemoryConfig(hybridMemoryConfig(cwd));
  return [
    `hybrid memory is ${config.enabled ? "enabled" : "disabled"}.`,
    `global settings: ${memoryToggleSettingsFile(cwd, "global")}`,
    `project settings: ${memoryToggleSettingsFile(cwd, "project")}`,
    "Use /hmemory-toggle off [--global|--project] to disable automatic injection/capture/import; /hmemory-toggle on to re-enable.",
  ].join("\n");
}
