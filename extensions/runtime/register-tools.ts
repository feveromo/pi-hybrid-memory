import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";

import { Type } from "typebox";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

import { MEMORY_LIMITS } from "../core/limits.ts";
import { doctorModeEnum, kindEnum, scopeEnum, searchStatusEnum, statusEnum, type MemoryKind, type MemoryRecord, type MemoryScope, type MemoryStatus } from "../core/domain.ts";
import { redactSecrets } from "../core/privacy.ts";

import { REPOMAP, nowIso, safeId, projectMemoryDir, paths, withHybridMemoryMutation, recordStatus, recordKey, appendRecord, updateRecord, forgetResultText, createForgetTombstone, updateProjectState, type UpdateRecordResult } from "./foundation.ts";
import { hybridMemoryConfig, publicHybridMemoryConfig, hybridMemoryEnabled, disabledHybridMemoryToolResult } from "./configuration.ts";
import { searchRecordsWithOptions, type SearchStatusFilter, type SearchRecordsOptions } from "./retrieval.ts";
import { buildRepoMap, regenerateProjectContext } from "./repo-context.ts";
import { boundedNumber, listSessionFiles, importSessions } from "./sessions.ts";
import { memoryStatsSnapshot, codebaseNoteFileEvidence, memoryDoctorPlan, applyMemoryDoctorPlan, formatMemoryStatsText, formatMemoryDoctorReport, writeMemoryDoctorReport, type MemoryStatsSnapshot, type MemoryDoctorPlan, type MemoryDoctorApplyResult } from "./curation.ts";
import { bootstrapProjectMemory, type BootstrapResult } from "./lifecycle.ts";
import { memoryKindIcon, memoryTheme, memoryToolText, memoryToolCall, memoryScopeChip, memoryKindChip, memoryToolPreview, memoryToolResultText, memoryRecordToolLine, memoryToolFilesLine, displayContent, explainMemorySelection } from "./presentation-retrieval.ts";

export function registerMemoryTools(
  pi: ExtensionAPI,
  controls: { updateMemoryChrome(ctx: any): void },
) {
  const { updateMemoryChrome } = controls;
  pi.registerTool({
    name: "hybrid_memory_explain",
    label: "Explain Memory Selection",
    description: "Preview the bounded memory block for a prompt and explain which records were retrieval candidates. Read-only.",
    promptSnippet: "Inspect why hybrid memory selected records for a prompt without changing stored memory.",
    promptGuidelines: ["Use hybrid_memory_explain to diagnose missing, noisy, or surprising memory retrieval. It is read-only."],
    parameters: Type.Object({
      query: Type.String({ maxLength: MEMORY_LIMITS.searchQuery, description: "Prompt or task to preview retrieval for." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!hybridMemoryEnabled(ctx.cwd)) return disabledHybridMemoryToolResult(ctx.cwd);
      const explanation = explainMemorySelection(ctx.cwd, params.query);
      const lines = explanation.candidates.map((item) => `- ${item.id} [${item.kind}; score ${item.score}${item.pinned ? "; pinned" : ""}]: ${item.subject}`);
      const text = [`Memory selection: ${explanation.chars}/${explanation.maxChars} chars; ${explanation.candidates.length} candidate(s).`, ...lines, "", explanation.block || "No memory block would be injected."].join("\n");
      return { content: [{ type: "text", text }], details: explanation };
    },
    renderCall(args, theme) {
      return memoryToolCall(theme, "🔎 explain memory", memoryTheme(theme, "muted", memoryToolPreview(args.query, 84)));
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return memoryToolText(memoryTheme(theme, "warning", "🔎 explaining memory selection…"));
      const details = result.details as ReturnType<typeof explainMemorySelection> | undefined;
      if (!details) return memoryToolText(memoryTheme(theme, "muted", memoryToolResultText(result)));
      let text = `${memoryTheme(theme, "success", "🔎 memory selection")} ${memoryTheme(theme, "accent", `${details.candidates.length} candidates`)} ${memoryTheme(theme, "dim", `• ${details.chars}/${details.maxChars} chars`)}`;
      if (expanded) for (const item of details.candidates.slice(0, 8)) text += `\n${memoryTheme(theme, item.pinned ? "warning" : "accent", item.id)} ${memoryTheme(theme, "dim", `${item.kind} score ${item.score}`)}`;
      return memoryToolText(text);
    },
  });

  pi.registerTool({
    name: "hybrid_memory_remember",
    label: "Hybrid Remember",
    description: "Store a durable typed memory record in local JSONL memory.",
    promptSnippet: "Store durable preferences, decisions, recipes, work items, or codebase notes in JSONL memory.",
    promptGuidelines: ["Use hybrid_memory_remember only for durable user preferences, explicit decisions, reusable recipes, or active project context; do not store secrets or raw tool output."],
    parameters: Type.Object({
      scope: Type.Optional(StringEnum(scopeEnum)),
      kind: StringEnum(kindEnum),
      subject: Type.String({ maxLength: MEMORY_LIMITS.subject, description: "Short stable key/title." }),
      content: Type.String({ maxLength: MEMORY_LIMITS.content, description: "Concise human-readable memory." }),
      tags: Type.Optional(Type.Array(Type.String({ maxLength: MEMORY_LIMITS.tag }), { maxItems: MEMORY_LIMITS.tagCount })),
      filePaths: Type.Optional(Type.Array(Type.String({ maxLength: MEMORY_LIMITS.filePath }), { maxItems: MEMORY_LIMITS.filePathCount })),
      symbols: Type.Optional(Type.Array(Type.String({ maxLength: MEMORY_LIMITS.symbol }), { maxItems: MEMORY_LIMITS.symbolCount })),
      salience: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
      pinned: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!hybridMemoryEnabled(ctx.cwd)) return disabledHybridMemoryToolResult(ctx.cwd);
      return withHybridMemoryMutation(ctx.cwd, async () => {
        const ts = nowIso();
        const scope = (params.scope ?? "project") as MemoryScope;
        const rec: MemoryRecord = {
          id: safeId(params.kind, redactSecrets(params.subject)),
          schemaVersion: 1,
          scope,
          kind: params.kind as MemoryKind,
          subject: params.subject,
          content: params.content,
          tags: params.tags ?? [],
          filePaths: params.filePaths,
          symbols: params.symbols,
          status: "active",
          salience: Math.max(1, Math.min(5, Math.round(params.salience ?? 3))) as 1 | 2 | 3 | 4 | 5,
          pinned: params.pinned ?? false,
          evidence: params.kind === "codebase_note" ? { files: codebaseNoteFileEvidence(ctx.cwd, params.filePaths) } : undefined,
          createdAt: ts,
          updatedAt: ts,
        };
        const stored = appendRecord(ctx.cwd, rec);
        updateMemoryChrome(ctx);
        return { content: [{ type: "text", text: `Remembered ${recordKey(stored)} in ${scope} memory.` }], details: stored };
      });
    },
    renderCall(args, theme) {
      const scope = String(args.scope ?? "project");
      const kind = String(args.kind ?? "memory");
      const pin = args.pinned ? `${memoryTheme(theme, "warning", "📌")} ` : "";
      const details = `${pin}${memoryScopeChip(theme, scope)} ${memoryKindChip(theme, kind)} ${memoryTheme(theme, "dim", `"${memoryToolPreview(args.subject, 72)}"`)}`;
      return memoryToolCall(theme, "🧠 remember", details);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return memoryToolText(memoryTheme(theme, "warning", "🧠 remembering memory…"));
      const rec = result.details as MemoryRecord | undefined;
      if (!rec) return memoryToolText(memoryTheme(theme, "muted", memoryToolResultText(result)));
      let text = `${memoryTheme(theme, "success", "✓ remembered")} ${memoryRecordToolLine(theme, rec)}`;
      if (expanded) {
        text += `\n${memoryTheme(theme, "dim", "id")} ${memoryTheme(theme, "accent", recordKey(rec))}`;
        text += `\n${memoryTheme(theme, "dim", "content")} ${memoryToolPreview(displayContent(rec), 180)}`;
        const files = memoryToolFilesLine(theme, rec.filePaths);
        if (files) text += `\n${files}`;
      }
      return memoryToolText(text);
    },
  });

  pi.registerTool({
    name: "hybrid_memory_search",
    label: "Hybrid Search",
    description: "Search local JSONL hybrid memory records by lexical/path/symbol relevance.",
    promptSnippet: "Search user and project hybrid memory records; supports scope/kind/status filters.",
    promptGuidelines: [
      "Use one hybrid_memory_search call for both user and project memory by default; do not repeat identical searches just to check both scopes.",
      "Use hybrid_memory_search status/includeInactive filters when auditing stale/done/superseded append-only history.",
    ],
    parameters: Type.Object({
      query: Type.String({ maxLength: MEMORY_LIMITS.searchQuery }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
      scope: Type.Optional(StringEnum(scopeEnum)),
      kind: Type.Optional(StringEnum(kindEnum)),
      status: Type.Optional(StringEnum(searchStatusEnum)),
      includeInactive: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!hybridMemoryEnabled(ctx.cwd)) return disabledHybridMemoryToolResult(ctx.cwd);
      const options: SearchRecordsOptions = {
        scope: params.scope as MemoryScope | undefined,
        kind: params.kind as MemoryKind | undefined,
        status: params.status as SearchStatusFilter | undefined,
        includeInactive: params.includeInactive,
      };
      const hits = searchRecordsWithOptions(ctx.cwd, params.query, params.limit ?? 12, options);
      return {
        content: [{ type: "text", text: hits.length ? hits.map((h) => `${recordKey(h.record)} [${h.record.kind}, ${recordStatus(h.record)}, score ${h.score}]: ${redactSecrets(displayContent(h.record))}`).join("\n") : "No hybrid memory hits." }],
        details: { hits, options },
      };
    },
    renderCall(args, theme) {
      const limit = args.limit ? memoryTheme(theme, "dim", `limit ${args.limit}`) : "";
      const filters = [args.scope, args.kind, args.status && args.status !== "active" ? args.status : undefined, args.includeInactive ? "all" : undefined].filter(Boolean).join("/");
      const filterText = filters ? memoryTheme(theme, "dim", ` ${filters}`) : "";
      return memoryToolCall(theme, "🔎 search", `${memoryTheme(theme, "accent", `"${memoryToolPreview(args.query, 80)}"`)}${filterText} ${limit}`.trim());
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return memoryToolText(memoryTheme(theme, "warning", "🔎 searching memory…"));
      const hits = ((result.details as any)?.hits ?? []) as Array<{ record: MemoryRecord; score: number }>;
      if (!hits.length) return memoryToolText(memoryTheme(theme, "dim", "No hybrid memory hits."));
      let text = `${memoryTheme(theme, "success", `🔎 ${hits.length} hit${hits.length === 1 ? "" : "s"}`)}`;
      for (const hit of hits.slice(0, expanded ? 8 : 3)) {
        text += `\n${memoryRecordToolLine(theme, hit.record, 76)} ${memoryTheme(theme, "dim", `score ${hit.score}`)}`;
        if (expanded) text += `\n  ${memoryTheme(theme, "dim", "id")} ${memoryTheme(theme, "accent", recordKey(hit.record))}`;
      }
      if (!expanded && hits.length > 3) text += `\n${memoryTheme(theme, "dim", `… ${hits.length - 3} more`)}`;
      return memoryToolText(text);
    },
  });

  pi.registerTool({
    name: "hybrid_memory_forget",
    label: "Hybrid Forget",
    description: "Mark a hybrid memory record done, stale, or superseded.",
    promptGuidelines: [
      "hybrid_memory_forget marks the latest record inactive through append-only JSONL history; it does not hard-delete raw history. Say this plainly when the user asks to forget.",
      "When a user wants something retired and not suggested again, pass tombstone: true with a short generic note to keep a tiny active do-not-suggest preference while retiring the old record.",
    ],
    parameters: Type.Object({
      id: Type.String({ maxLength: MEMORY_LIMITS.id + 8 }),
      status: Type.Optional(StringEnum(statusEnum)),
      scope: Type.Optional(StringEnum(scopeEnum)),
      note: Type.Optional(Type.String({ maxLength: MEMORY_LIMITS.note })),
      tombstone: Type.Optional(Type.Boolean()),
      tombstoneNote: Type.Optional(Type.String({ maxLength: MEMORY_LIMITS.note })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!hybridMemoryEnabled(ctx.cwd)) return disabledHybridMemoryToolResult(ctx.cwd);
      return withHybridMemoryMutation(ctx.cwd, async () => {
        const status = (params.status ?? "stale") as MemoryStatus;
        const patch: Partial<MemoryRecord> = { status };
        if (params.note) patch.evidence = { note: redactSecrets(params.note) };
        const result = updateRecord(ctx.cwd, params.id, patch, params.scope as MemoryScope | undefined);
        const tombstone = result.updated && params.tombstone ? createForgetTombstone(ctx.cwd, result.updated, params.tombstoneNote ?? params.note) : undefined;
        return { content: [{ type: "text", text: forgetResultText(result, params.id, status, tombstone) }], details: { ...result, tombstone } };
      });
    },
    renderCall(args, theme) {
      const status = String(args.status ?? "stale");
      const scope = args.scope ? `${memoryScopeChip(theme, String(args.scope))} ` : "";
      return memoryToolCall(theme, "🧹 forget", `${scope}${memoryTheme(theme, "accent", memoryToolPreview(args.id, 72))} ${memoryTheme(theme, "dim", `→ ${status}`)}`);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return memoryToolText(memoryTheme(theme, "warning", "🧹 updating memory…"));
      const details = result.details as (UpdateRecordResult & { tombstone?: MemoryRecord }) | undefined;
      if (details?.updated) {
        const status = recordStatus(details.updated);
        let text = `${memoryTheme(theme, "success", `✓ marked ${status}`)} ${memoryRecordToolLine(theme, details.updated)} ${memoryTheme(theme, "dim", status === "active" ? "active" : "inactive, append-only")}`;
        if (expanded) text += `\n${memoryTheme(theme, "dim", status === "active" ? "record is active again" : "not hard-deleted; inactive records stay out of injection/search by default")}`;
        if (expanded && details.updated.evidence?.note) text += `\n${memoryTheme(theme, "dim", "note")} ${memoryToolPreview(details.updated.evidence.note, 160)}`;
        if (details.tombstone) text += `\n${memoryTheme(theme, "warning", "do-not-suggest")} ${memoryRecordToolLine(theme, details.tombstone, 70, true)}`;
        return memoryToolText(text);
      }
      if (details?.ambiguous?.length) {
        const ids = details.ambiguous.map(recordKey).join(" or ");
        return memoryToolText(`${memoryTheme(theme, "warning", "Ambiguous memory id")}: ${memoryTheme(theme, "accent", ids)}`);
      }
      return memoryToolText(memoryTheme(theme, "error", memoryToolResultText(result) || "No record found."));
    },
  });

  pi.registerTool({
    name: "hybrid_memory_import_sessions",
    label: "Import Sessions",
    description: "Populate hybrid memory from Pi session JSONL files using conservative recaps and explicit user-stated preferences.",
    promptSnippet: "Import concise session recaps and explicit user preferences from Pi session JSONL files into hybrid memory.",
    promptGuidelines: ["Use hybrid_memory_import_sessions when the user asks to populate memory from previous sessions. Prefer recent/project-only imports unless the user asks for all sessions."],
    parameters: Type.Object({
      sessionPath: Type.Optional(Type.String({ maxLength: MEMORY_LIMITS.sessionPath, description: "Specific Pi session .jsonl path. Omit to import recent sessions." })),
      recent: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
      projectOnly: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      if (!hybridMemoryEnabled(ctx.cwd)) return disabledHybridMemoryToolResult(ctx.cwd);
      onUpdate?.({ content: [{ type: "text", text: "Importing session memory..." }], details: { stage: "importing" } });
      return withHybridMemoryMutation(ctx.cwd, async () => {
        const files = params.sessionPath
          ? [resolve(params.sessionPath.replace(/^~/, homedir()))]
          : listSessionFiles(params.recent ?? 10, params.projectOnly === false ? undefined : ctx.cwd);
        const result = importSessions(ctx.cwd, files.filter((f) => existsSync(f)), { requireSessionRoot: true });
        updateMemoryChrome(ctx);
        return { content: [{ type: "text", text: `Imported sessions: scanned ${result.scanned}, extracted ${result.extracted}, wrote ${result.written}.` }], details: result };
      });
    },
    renderCall(args, theme) {
      const source = args.sessionPath ? memoryToolPreview(args.sessionPath, 72) : `${args.recent ?? 10} recent${args.projectOnly === false ? "" : " project"}`;
      return memoryToolCall(theme, "📥 import sessions", memoryTheme(theme, "muted", source));
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return memoryToolText(memoryTheme(theme, "warning", "📥 importing session memory…"));
      const details = result.details as ReturnType<typeof importSessions> | undefined;
      if (!details) return memoryToolText(memoryTheme(theme, "muted", memoryToolResultText(result)));
      let text = `${memoryTheme(theme, "success", "📥 imported")} ${memoryTheme(theme, "accent", String(details.written))} ${memoryTheme(theme, "muted", "writes")} ${memoryTheme(theme, "dim", `(scanned ${details.scanned}, extracted ${details.extracted})`)}`;
      if (expanded && details.sessionFiles?.length) {
        for (const file of details.sessionFiles.slice(0, 6)) text += `\n${memoryTheme(theme, "dim", memoryToolPreview(file, 120))}`;
        if (details.sessionFiles.length > 6) text += `\n${memoryTheme(theme, "dim", `… ${details.sessionFiles.length - 6} more files`)}`;
      }
      return memoryToolText(text);
    },
  });

  pi.registerTool({
    name: "hybrid_memory_refresh_context",
    label: "Refresh Memory Context",
    description: "Refresh the project repo map and optionally import recent session memories.",
    promptSnippet: "Refresh hybrid memory context by rebuilding the repo map and importing recent session recaps.",
    parameters: Type.Object({
      recentSessions: Type.Optional(Type.Number({ minimum: 0, maximum: 50 })),
      importSessions: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      if (!hybridMemoryEnabled(ctx.cwd)) return disabledHybridMemoryToolResult(ctx.cwd);
      onUpdate?.({ content: [{ type: "text", text: "Refreshing repo map..." }], details: { stage: "mapping" } });
      return withHybridMemoryMutation(ctx.cwd, async () => {
        const map = buildRepoMap(ctx.cwd);
        let importResult: ReturnType<typeof importSessions> | undefined;
        if (params.importSessions ?? true) {
          const current = ctx.sessionManager.getSessionFile();
          const recent = params.recentSessions ?? 5;
          const files = [...new Set([...(current ? [current] : []), ...listSessionFiles(recent, ctx.cwd)])];
          importResult = importSessions(ctx.cwd, files);
        }
        regenerateProjectContext(ctx.cwd, map);
        updateProjectState(ctx.cwd, { lastToolRefreshAt: nowIso(), lastToolRefreshSessionsWritten: importResult?.written ?? 0 });
        updateMemoryChrome(ctx);
        return { content: [{ type: "text", text: `Refreshed repo map (${map.files.length} files)${importResult ? ` and session memory (${importResult.written} writes)` : ""}.` }], details: { repoMap: { path: join(projectMemoryDir(ctx.cwd), REPOMAP), files: map.files.length }, importResult } };
      });
    },
    renderCall(args, theme) {
      const sessions = args.importSessions === false ? "repo only" : `${args.recentSessions ?? 5} sessions`;
      return memoryToolCall(theme, "🔄 refresh context", memoryTheme(theme, "muted", sessions));
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return memoryToolText(memoryTheme(theme, "warning", "🔄 refreshing memory context…"));
      const details = result.details as { repoMap?: { path: string; files: number }; importResult?: ReturnType<typeof importSessions> } | undefined;
      if (!details?.repoMap) return memoryToolText(memoryTheme(theme, "muted", memoryToolResultText(result)));
      let text = `${memoryTheme(theme, "success", "🔄 refreshed")} ${memoryTheme(theme, "accent", `${details.repoMap.files} files`)}`;
      if (details.importResult) text += ` ${memoryTheme(theme, "dim", `• ${details.importResult.written} session writes`)}`;
      if (expanded) text += `\n${memoryTheme(theme, "dim", details.repoMap.path)}`;
      return memoryToolText(text);
    },
  });

  pi.registerTool({
    name: "hybrid_memory_bootstrap_project",
    label: "Bootstrap Project Memory",
    description: "One-time deep local backfill: rebuild repo map, import prior project sessions, prune duplicates, and roll up old recaps.",
    promptSnippet: "Bootstrap project memory from local Pi session history when entering an older project for the first time.",
    parameters: Type.Object({
      maxSessions: Type.Optional(Type.Number({ minimum: 10, maximum: 500 })),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      if (!hybridMemoryEnabled(ctx.cwd)) return disabledHybridMemoryToolResult(ctx.cwd);
      onUpdate?.({ content: [{ type: "text", text: "Bootstrapping project memory from local sessions..." }], details: { stage: "bootstrapping" } });
      return withHybridMemoryMutation(ctx.cwd, async () => {
        const result = bootstrapProjectMemory(ctx.cwd, boundedNumber(params.maxSessions, 250, 10, 500));
        updateMemoryChrome(ctx);
        return { content: [{ type: "text", text: `Bootstrapped project memory: repo map ${result.repoFiles} files; sessions scanned ${result.sessions.scanned}, extracted ${result.sessions.extracted}, wrote ${result.sessions.written}; pruned ${result.prune.staleMarked}.` }], details: result };
      });
    },
    renderCall(args, theme) {
      return memoryToolCall(theme, "🌱 bootstrap project", memoryTheme(theme, "muted", `${args.maxSessions ?? 250} sessions max`));
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return memoryToolText(memoryTheme(theme, "warning", "🌱 bootstrapping project memory…"));
      const details = result.details as BootstrapResult | undefined;
      if (!details) return memoryToolText(memoryTheme(theme, "muted", memoryToolResultText(result)));
      let text = `${memoryTheme(theme, "success", "🌱 bootstrapped")} ${memoryTheme(theme, "accent", `${details.repoFiles} repo files`)} ${memoryTheme(theme, "dim", `• ${details.sessions.written} writes • ${details.prune.staleMarked} pruned`)}`;
      if (expanded) {
        text += `\n${memoryTheme(theme, "dim", `sessions scanned ${details.sessions.scanned}/${details.scannedAvailable}, extracted ${details.sessions.extracted}`)}`;
        if (details.prune.rollupCreated) text += `\n${memoryTheme(theme, "dim", "rollup")} ${memoryTheme(theme, "accent", recordKey(details.prune.rollupCreated))}`;
      }
      return memoryToolText(text);
    },
  });

  pi.registerTool({
    name: "hybrid_memory_stats",
    label: "Hybrid Stats",
    description: "Show hybrid memory record counts and storage paths.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (!hybridMemoryEnabled(ctx.cwd)) return disabledHybridMemoryToolResult(ctx.cwd);
      const p = paths(ctx.cwd);
      const stats = memoryStatsSnapshot(ctx.cwd);
      const config = publicHybridMemoryConfig(hybridMemoryConfig(ctx.cwd));
      return { content: [{ type: "text", text: formatMemoryStatsText(stats, p) }], details: { paths: p, ...stats, config } };
    },
    renderCall(args, theme) {
      return memoryToolCall(theme, "📊 stats", memoryTheme(theme, "muted", "memory health"));
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return memoryToolText(memoryTheme(theme, "warning", "📊 reading memory stats…"));
      const details = result.details as (MemoryStatsSnapshot & { paths?: ReturnType<typeof paths>; config?: Record<string, unknown> }) | undefined;
      if (!details) return memoryToolText(memoryTheme(theme, "muted", memoryToolResultText(result)));
      const topKinds = kindEnum
        .map((k) => [k, details.activeByKind?.[k] ?? 0] as const)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${memoryKindIcon(k)} ${n}`)
        .join("  ");
      let text = `${memoryTheme(theme, "success", "📊 hybrid memory")} ${memoryTheme(theme, "accent", `${details.active ?? 0} active`)} ${memoryTheme(theme, "dim", `/ ${details.total ?? 0} total`)}`;
      if (topKinds) text += ` ${memoryTheme(theme, "dim", topKinds)}`;
      if (expanded) {
        text += `\n${memoryTheme(theme, "dim", "inactive")} stale ${details.byStatus?.stale ?? 0} • superseded ${details.byStatus?.superseded ?? 0} • done ${details.byStatus?.done ?? 0}`;
        text += `\n${memoryTheme(theme, "dim", "hygiene ")} duplicates ${details.duplicateSubjects?.length ?? 0} • stale candidates ${details.staleCandidateCount ?? 0} • scope hints ${details.scopeMismatchCount ?? 0}`;
        if (details.paths) {
          text += `\n${memoryTheme(theme, "dim", "user")} ${details.paths.user}`;
          text += `\n${memoryTheme(theme, "dim", "project")} ${details.paths.project}`;
        }
        if (details.config?.maxInjectChars) text += `\n${memoryTheme(theme, "dim", `inject cap ${details.config.maxInjectChars}`)}`;
      }
      return memoryToolText(text);
    },
  });

  pi.registerTool({
    name: "hybrid_memory_doctor",
    label: "Hybrid Doctor",
    description: "Preview or apply deterministic hybrid-memory cleanup: active/inactive counts, duplicate/noisy stale candidates, scope/preference review hints, and a report file.",
    parameters: Type.Object({
      mode: Type.Optional(StringEnum(doctorModeEnum)),
      maxActiveRecaps: Type.Optional(Type.Number({ minimum: 3, maximum: 100 })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!hybridMemoryEnabled(ctx.cwd)) return disabledHybridMemoryToolResult(ctx.cwd);
      return withHybridMemoryMutation(ctx.cwd, async () => {
        const mode = (params.mode ?? "preview") as "preview" | "apply";
        const max = boundedNumber(params.maxActiveRecaps, hybridMemoryConfig(ctx.cwd).pruneActiveSessionRecaps, 3, 100);
        const plan = memoryDoctorPlan(ctx.cwd, max);
        let applyResult: MemoryDoctorApplyResult | undefined;
        let after: MemoryStatsSnapshot | undefined;
        if (mode === "apply") {
          applyResult = applyMemoryDoctorPlan(ctx.cwd, plan);
          after = memoryStatsSnapshot(ctx.cwd);
          updateProjectState(ctx.cwd, { lastDoctorAppliedAt: nowIso(), lastDoctorApplied: applyResult.applied, lastDoctorSkipped: applyResult.skipped.length });
        }
        const report = formatMemoryDoctorReport({ plan, applyResult, after });
        const reportPath = writeMemoryDoctorReport(ctx.cwd, report, mode);
        updateProjectState(ctx.cwd, { lastToolDoctorAt: nowIso(), lastToolDoctorPath: reportPath, lastToolDoctorCandidates: plan.candidates.length, lastToolDoctorScopeHints: plan.scopeHints.length, lastToolDoctorReviewHints: plan.reviewHints.length });
        updateMemoryChrome(ctx);
        const applied = applyResult ? ` Applied ${applyResult.applied}.` : "";
        return { content: [{ type: "text", text: `Memory doctor ${mode}: ${plan.candidates.length} safe cleanup candidates; ${plan.scopeHints.length} scope hints; ${plan.reviewHints.length} preference review hints.${applied} Report: ${reportPath}` }], details: { plan, applyResult, after, reportPath, mode } };
      });
    },
    renderCall(args, theme) {
      const mode = String(args.mode ?? "preview");
      return memoryToolCall(theme, "🩺 doctor", `${memoryTheme(theme, mode === "apply" ? "warning" : "muted", mode)}${args.maxActiveRecaps ? memoryTheme(theme, "dim", ` max ${args.maxActiveRecaps}`) : ""}`);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return memoryToolText(memoryTheme(theme, "warning", "🩺 checking memory health…"));
      const details = result.details as { plan?: MemoryDoctorPlan; applyResult?: MemoryDoctorApplyResult; reportPath?: string; mode?: string } | undefined;
      if (!details?.plan) return memoryToolText(memoryTheme(theme, "muted", memoryToolResultText(result)));
      let text = `${memoryTheme(theme, "success", "🩺 memory doctor")} ${memoryTheme(theme, "accent", `${details.plan.candidates.length} candidate${details.plan.candidates.length === 1 ? "" : "s"}`)} ${memoryTheme(theme, "dim", `• ${details.plan.scopeHints.length} scope hint${details.plan.scopeHints.length === 1 ? "" : "s"}`)} ${memoryTheme(theme, "dim", `• ${details.plan.reviewHints.length} preference hint${details.plan.reviewHints.length === 1 ? "" : "s"}`)}`;
      if (details.applyResult) text += ` ${memoryTheme(theme, details.applyResult.applied ? "success" : "muted", `• applied ${details.applyResult.applied}`)}`;
      if (expanded) {
        for (const candidate of details.plan.candidates.slice(0, 6)) text += `\n${memoryTheme(theme, "dim", "stale")} ${memoryTheme(theme, "accent", recordKey(candidate.record))} ${memoryTheme(theme, "dim", candidate.reason)}`;
        for (const hint of details.plan.reviewHints.slice(0, 4)) text += `\n${memoryTheme(theme, "dim", "review")} ${memoryTheme(theme, "accent", recordKey(hint.record))} ${memoryTheme(theme, "dim", hint.reason)}`;
        if (details.plan.candidates.length > 6) text += `\n${memoryTheme(theme, "dim", `… ${details.plan.candidates.length - 6} more candidates`)}`;
        if (details.plan.reviewHints.length > 4) text += `\n${memoryTheme(theme, "dim", `… ${details.plan.reviewHints.length - 4} more preference hints`)}`;
        if (details.reportPath) text += `\n${memoryTheme(theme, "dim", "report")} ${details.reportPath}`;
      }
      return memoryToolText(text);
    },
  });

  pi.registerTool({
    name: "hybrid_memory_build_repomap",
    label: "Build Repo Map",
    description: "Build or refresh lightweight repo map cache for the current project.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, onUpdate, ctx) {
      if (!hybridMemoryEnabled(ctx.cwd)) return disabledHybridMemoryToolResult(ctx.cwd);
      onUpdate?.({ content: [{ type: "text", text: "Building repo map..." }], details: { stage: "mapping" } });
      return withHybridMemoryMutation(ctx.cwd, async () => {
        const map = buildRepoMap(ctx.cwd);
        updateMemoryChrome(ctx);
        return { content: [{ type: "text", text: `Repo map built for ${map.root}: ${map.files.length} files.` }], details: { path: join(projectMemoryDir(ctx.cwd), REPOMAP), files: map.files.length } };
      });
    },
    renderCall(args, theme) {
      return memoryToolCall(theme, "🗺️ repo map", memoryTheme(theme, "muted", "build cache"));
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return memoryToolText(memoryTheme(theme, "warning", "🗺️ building repo map…"));
      const details = result.details as { path?: string; files?: number } | undefined;
      if (!details) return memoryToolText(memoryTheme(theme, "muted", memoryToolResultText(result)));
      let text = `${memoryTheme(theme, "success", "🗺️ repo map built")} ${memoryTheme(theme, "accent", `${details.files ?? 0} files`)}`;
      if (expanded && details.path) text += `\n${memoryTheme(theme, "dim", details.path)}`;
      return memoryToolText(text);
    },
  });
}
