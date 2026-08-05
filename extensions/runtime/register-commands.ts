import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

import { statusEnum, type MemoryRecord, type MemoryStatus } from "../core/domain.ts";
import { redactSecrets } from "../core/privacy.ts";
import { cleanArgToken, compactText } from "../core/text.ts";
import { atomicWriteFileSync } from "../core/atomic-file.ts";

import { REPOMAP, CONTEXT, nowIso, safeId, projectMemoryDir, paths, withHybridMemoryMutation, latestRecordsForCwd, activeRecords, recordStatus, recordKey, appendRecord, updateRecord, updateResultText, forgetResultText, resolveRecord, formatRecord, updateProjectState } from "./foundation.ts";
import { hybridMemoryConfig, formatHybridMemoryConfig, hybridMemoryEnabled, setHybridMemoryEnabled, parseMemoryToggleArgs, hybridMemoryToggleStatusText } from "./configuration.ts";
import { searchRecordsWithOptions, formatForgetPreview } from "./retrieval.ts";
import { buildRepoMap, readRepoMap, repoMapStaleness, regenerateProjectContext, repoExcerpt } from "./repo-context.ts";
import { boundedNumber, listSessionFiles, importSessions } from "./sessions.ts";
import { memoryStatsSnapshot, memoryHealth, memoryDoctorPlan, applyMemoryDoctorPlan, formatMemoryStatsText, formatMemoryDoctorReport, writeMemoryDoctorReport, pruneMemory, type MemoryStatsSnapshot, type MemoryDoctorApplyResult } from "./curation.ts";
import { bootstrapProjectMemory } from "./lifecycle.ts";
import { displayContent, buildReviewLines, buildDashboardLines, explainMemorySelection } from "./presentation-retrieval.ts";
import { modelLabel, applyMemoryAuditPlan, formatMemoryAuditReport, filterMemoryAuditPlan, generateMemoryAudit, type MemoryAuditFilters, type MemoryAuditResult } from "./audit.ts";
import { createMemoryAuditProgress, chooseMemoryAuditActionIndexes } from "./audit-ui.ts";
import { parseMemoryAuditArgs, parseMemorySearchArgs, parseMemoryDoctorArgs } from "./command-args.ts";
import { parseMemoryPurgeArgs, purgeMemoryRecord } from "./memory-purge.ts";

export function registerMemoryCommands(
  pi: ExtensionAPI,
  controls: { updateMemoryChrome(ctx: any): void; applyHybridMemoryToolState(ctx: any, activate?: boolean): void },
) {
  const { updateMemoryChrome, applyHybridMemoryToolState } = controls;
  pi.registerCommand("hmemory", {
    description: "Show hybrid JSONL memory stats",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatMemoryStatsText(memoryStatsSnapshot(ctx.cwd), paths(ctx.cwd)), "info");
    },
  });

  pi.registerCommand("hmemory-config", {
    description: "Show active hybrid-memory tuning from Pi settings",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`hybrid memory config:\n${formatHybridMemoryConfig(ctx.cwd)}`, "info");
    },
  });

  pi.registerCommand("hmemory-toggle", {
    description: "Enable/disable automatic hybrid memory: /hmemory-toggle on|off [--global|--project]",
    handler: async (args, ctx) => {
      const parsed = parseMemoryToggleArgs(args);
      if (parsed.status) return ctx.ui.notify(hybridMemoryToggleStatusText(ctx.cwd), "info");
      const requested = Boolean(parsed.enabled);
      const file = setHybridMemoryEnabled(ctx.cwd, requested, parsed.target);
      const effective = hybridMemoryEnabled(ctx.cwd);
      applyHybridMemoryToolState(ctx, effective);
      updateMemoryChrome(ctx);
      const overrideNote = effective === requested ? "" : ` Effective status is still ${effective ? "enabled" : "disabled"} because another settings layer overrides this ${parsed.target} value.`;
      ctx.ui.notify(
        requested
          ? `hybrid memory enabled (${parsed.target}; ${file}). Automatic injection/capture/import will run on future turns.${overrideNote}`
          : `hybrid memory disabled (${parsed.target}; ${file}). Automatic injection/capture/import and hybrid-memory tools are off; stored JSONL data is retained. Use /hmemory-toggle on to re-enable.${overrideNote}`,
        "info",
      );
    },
  });

  pi.registerCommand("hmemory-search", {
    description: "Search hybrid JSONL memory; flags: --all --scope user|project --kind recipe --status stale",
    handler: async (args, ctx) => {
      const parsed = parseMemorySearchArgs(args);
      const hits = searchRecordsWithOptions(ctx.cwd, parsed.query, 8, parsed.options);
      ctx.ui.notify(hits.length ? hits.map((h) => `${recordKey(h.record)} [${h.record.kind}, ${recordStatus(h.record)}]: ${redactSecrets(displayContent(h.record))}`).join("\n") : "No hybrid memory hits.", "info");
    },
  });

  pi.registerCommand("hmemory-repomap", {
    description: "Rebuild lightweight repo map cache for the current project",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("hybrid-memory", "map");
      try {
        await withHybridMemoryMutation(ctx.cwd, async () => {
          const map = buildRepoMap(ctx.cwd);
          ctx.ui.notify(`repo map: ${map.files.length} files -> ${join(projectMemoryDir(ctx.cwd), REPOMAP)}`, "info");
        });
      } finally {
        updateMemoryChrome(ctx);
      }
    },
  });

  pi.registerCommand("hmemory-purge", {
    description: "Hard-delete all JSONL versions of one memory: /hmemory-purge <scoped-id> --force",
    handler: async (args, ctx) => {
      const parsed = parseMemoryPurgeArgs(args);
      if (!parsed.id || !parsed.force) return ctx.ui.notify("Usage: /hmemory-purge <scoped-id> --force [--scope user|project]. This rewrites records.jsonl and does not log purged content.", "error");
      await withHybridMemoryMutation(ctx.cwd, async () => {
        const result = purgeMemoryRecord(ctx.cwd, parsed.id, parsed.scope);
        if (result.ambiguous?.length) return ctx.ui.notify(`Ambiguous memory id ${parsed.id}; use ${result.ambiguous.map(recordKey).join(" or ")}.`, "error");
        if (!result.removed) return ctx.ui.notify(`No record found for ${parsed.id}; nothing purged.`, "info");
        ctx.ui.notify(`purged ${result.scope}:${result.id}: removed ${result.removed} JSONL entr${result.removed === 1 ? "y" : "ies"}. Audit marker: ${result.auditPath}`, "info");
      });
      updateMemoryChrome(ctx);
    },
  });

  pi.registerCommand("hmemory-forget", {
    description: "Mark a memory stale/done/superseded: /hmemory-forget <id|query> [status]",
    handler: async (args, ctx) => {
      const tokens = args.match(/(?:"[^"]*"|'[^']*'|\S+)/g)?.map(cleanArgToken) ?? [];
      const statusArg = tokens.at(-1);
      const status = statusEnum.includes(statusArg as MemoryStatus) ? statusArg as MemoryStatus : "stale";
      const target = (statusArg && statusEnum.includes(statusArg as MemoryStatus) ? tokens.slice(0, -1) : tokens).join(" ").trim();
      if (!target) return ctx.ui.notify("Usage: /hmemory-forget <id|query> [stale|done|superseded]", "error");
      await withHybridMemoryMutation(ctx.cwd, async () => {
        const result = updateRecord(ctx.cwd, target, { status });
        if (result.updated || result.ambiguous?.length) {
          ctx.ui.notify(forgetResultText(result, target, status), result.updated ? "info" : "error");
          return;
        }
        ctx.ui.notify(formatForgetPreview(ctx.cwd, target, status), "info");
      });
      updateMemoryChrome(ctx);
    },
  });

  pi.registerCommand("hmemory-ingest-session", {
    description: "Import memories from sessions: current, recent N, or a .jsonl path",
    handler: async (args, ctx) => {
      ctx.ui.setStatus("hybrid-memory", "ingest");
      try {
        await withHybridMemoryMutation(ctx.cwd, async () => {
          const trimmed = args.trim();
          let files: string[] = [];
          if (!trimmed || trimmed === "current") {
            const current = ctx.sessionManager.getSessionFile();
            if (current) files = [current];
          } else if (trimmed.startsWith("recent")) {
            const n = boundedNumber(trimmed.split(/\s+/)[1], 10, 1, 50);
            files = listSessionFiles(n, ctx.cwd);
          } else {
            files = [resolve(trimmed.replace(/^~/, homedir()))];
          }
          const result = importSessions(ctx.cwd, files.filter((f) => existsSync(f)));
          ctx.ui.notify(`session import: scanned ${result.scanned}, extracted ${result.extracted}, wrote ${result.written}`, "info");
        });
      } finally {
        updateMemoryChrome(ctx);
      }
    },
  });

  pi.registerCommand("hmemory-refresh", {
    description: "Refresh repo map and import recent session recaps",
    handler: async (args, ctx) => {
      const recent = boundedNumber(args.trim(), 5, 0, 50);
      ctx.ui.setStatus("hybrid-memory", "refresh");
      try {
        await withHybridMemoryMutation(ctx.cwd, async () => {
          const map = buildRepoMap(ctx.cwd);
          const current = ctx.sessionManager.getSessionFile();
          const files = [...new Set([...(current ? [current] : []), ...listSessionFiles(recent, ctx.cwd)])];
          const result = importSessions(ctx.cwd, files);
          regenerateProjectContext(ctx.cwd, map);
          updateProjectState(ctx.cwd, { lastManualRefreshAt: nowIso(), lastManualRefreshSessionsScanned: result.scanned, lastManualRefreshSessionsWritten: result.written });
          ctx.ui.notify(`refresh: repo map ${map.files.length} files; sessions scanned ${result.scanned}, extracted ${result.extracted}, wrote ${result.written}`, "info");
        });
      } finally {
        updateMemoryChrome(ctx);
      }
    },
  });

  pi.registerCommand("hmemory-bootstrap", {
    description: "One-time deep local backfill for a project: repo map, all prior project sessions, prune/rollup",
    handler: async (args, ctx) => {
      const max = boundedNumber(args.trim(), 250, 10, 500);
      ctx.ui.setStatus("hybrid-memory", "bootstrap");
      try {
        await withHybridMemoryMutation(ctx.cwd, async () => {
          const result = bootstrapProjectMemory(ctx.cwd, max);
          ctx.ui.notify(`bootstrap: repo map ${result.repoFiles} files; sessions scanned ${result.sessions.scanned}/${result.scannedAvailable}, extracted ${result.sessions.extracted}, wrote ${result.sessions.written}; pruned ${result.prune.staleMarked}${result.prune.rollupCreated ? `; rollup ${recordKey(result.prune.rollupCreated)}` : ""}`, "info");
        });
      } finally {
        updateMemoryChrome(ctx);
      }
    },
  });

  pi.registerCommand("hmemory-health", {
    description: "Show hybrid memory health, stale repo map status, and duplicate hints",
    handler: async (_args, ctx) => {
      const h = memoryHealth(ctx.cwd);
      const dupes = h.duplicateSubjects.length ? `\nduplicates: ${h.duplicateSubjects.map(([k, n]) => `${k} x${n}`).join("; ")}` : "";
      ctx.ui.notify(`${formatMemoryStatsText(h.stats)}${dupes}`, "info");
    },
  });

  pi.registerCommand("hmemory-doctor", {
    description: "Preview/apply deterministic memory cleanup and write a curation report: /hmemory-doctor [preview|apply] [maxRecaps]",
    handler: async (args, ctx) => {
      await withHybridMemoryMutation(ctx.cwd, async () => {
        const parsed = parseMemoryDoctorArgs(args);
        const max = parsed.maxActiveSessionRecaps ?? hybridMemoryConfig(ctx.cwd).pruneActiveSessionRecaps;
        const plan = memoryDoctorPlan(ctx.cwd, max);
        let applyResult: MemoryDoctorApplyResult | undefined;
        let after: MemoryStatsSnapshot | undefined;
        if (parsed.mode === "apply") {
          applyResult = applyMemoryDoctorPlan(ctx.cwd, plan);
          after = memoryStatsSnapshot(ctx.cwd);
          updateProjectState(ctx.cwd, { lastDoctorAppliedAt: nowIso(), lastDoctorApplied: applyResult.applied, lastDoctorSkipped: applyResult.skipped.length });
        }
        const report = formatMemoryDoctorReport({ plan, applyResult, after });
        const reportPath = writeMemoryDoctorReport(ctx.cwd, report, parsed.mode);
        updateProjectState(ctx.cwd, { lastDoctorAt: nowIso(), lastDoctorPath: reportPath, lastDoctorCandidates: plan.candidates.length, lastDoctorScopeHints: plan.scopeHints.length, lastDoctorReviewHints: plan.reviewHints.length });
        const noun = plan.candidates.length === 1 ? "candidate" : "candidates";
        const scopeNoun = plan.scopeHints.length === 1 ? "hint" : "hints";
        const reviewNoun = plan.reviewHints.length === 1 ? "hint" : "hints";
        ctx.ui.notify(`memory doctor ${parsed.mode}: ${plan.candidates.length} safe cleanup ${noun}; ${plan.scopeHints.length} scope ${scopeNoun}; ${plan.reviewHints.length} preference review ${reviewNoun}${applyResult ? `; applied ${applyResult.applied}` : ""}; report ${reportPath}`, "info");
      });
      updateMemoryChrome(ctx);
    },
  });

  pi.registerCommand("hmemory-show", {
    description: "Show one memory record: /hmemory-show <id>",
    handler: async (args, ctx) => {
      const id = args.trim().split(/\s+/)[0];
      if (!id) return ctx.ui.notify("Usage: /hmemory-show <id>", "error");
      const result = resolveRecord(ctx.cwd, id);
      ctx.ui.notify(result.updated ? formatRecord(result.updated) : updateResultText(result, id, ""), result.updated ? "info" : "error");
    },
  });

  pi.registerCommand("hmemory-prune", {
    description: "Prune duplicate/old session-recapped memories; optional max active recaps: /hmemory-prune [12] or configured default",
    handler: async (args, ctx) => {
      await withHybridMemoryMutation(ctx.cwd, async () => {
        const max = boundedNumber(args.trim(), hybridMemoryConfig(ctx.cwd).pruneActiveSessionRecaps, 3, 100);
        const result = pruneMemory(ctx.cwd, max);
        ctx.ui.notify(`memory prune: marked ${result.staleMarked} stale; duplicate groups ${result.duplicateGroups}${result.rollupCreated ? `; rollup ${recordKey(result.rollupCreated)}` : ""}`, "info");
      });
      updateMemoryChrome(ctx);
    },
  });

  pi.registerCommand("hmemory-audit", {
    description: "Use the selected Pi model to audit, clean, dedupe, and organize memory; supports --scope, --kind, --page, --limit, --actions",
    handler: async (args, ctx) => {
      const options = parseMemoryAuditArgs(args);
      const filters: MemoryAuditFilters = { query: options.query, scope: options.scope, kind: options.kind, page: options.page, limit: options.limit };
      ctx.ui.setStatus("hybrid-memory", "audit");
      let audit: MemoryAuditResult | undefined;
      let auditError: unknown;
      try {
        if (ctx.hasUI) {
          const visualAudit = await ctx.ui.custom<MemoryAuditResult | null>((tui, theme, _kb, done) => {
            const progress = createMemoryAuditProgress(tui, theme, ctx.model ? modelLabel(ctx.model) : "selected model", filters);
            progress.setOnAbort(() => done(null));
            generateMemoryAudit(ctx.cwd, ctx, filters, progress.signal, progress.update)
              .then((result) => done(result ?? null))
              .catch((err) => {
                auditError = err;
                done(null);
              });
            return progress.component;
          }) as MemoryAuditResult | null | undefined;
          if (auditError) throw auditError;
          if (visualAudit === null) return ctx.ui.notify("memory audit cancelled", "info");
          audit = visualAudit;
        }
        if (!audit) {
          audit = await generateMemoryAudit(ctx.cwd, ctx, filters);
          if (!audit) return;
        }

        const completedAudit = audit;
        const actionCount = completedAudit.plan.actions.length;
        let selectedActionIndexes = options.actionIndexes?.filter((index) => index >= 0 && index < actionCount);
        let shouldApply = options.apply && !options.dryRun;
        if (!shouldApply && !options.dryRun && ctx.hasUI && actionCount > 0) {
          const selected = await chooseMemoryAuditActionIndexes(ctx, completedAudit);
          if (selected === null) return ctx.ui.notify(`memory audit proposed ${actionCount} change${actionCount === 1 ? "" : "s"}; cancelled before apply; report ${completedAudit.reportPath}`, "info");
          selectedActionIndexes = selected;
          shouldApply = selected.length > 0;
        }
        if (shouldApply && actionCount > 0 && !selectedActionIndexes) selectedActionIndexes = completedAudit.plan.actions.map((_action, index) => index);
        const applyPlan = filterMemoryAuditPlan(completedAudit.plan, selectedActionIndexes);

        if (shouldApply && applyPlan.actions.length > 0) {
          await withHybridMemoryMutation(ctx.cwd, async () => {
            const applyResult = applyMemoryAuditPlan(ctx.cwd, applyPlan);
            const report = formatMemoryAuditReport({ plan: completedAudit.plan, model: completedAudit.model, filters: completedAudit.filters, recordsAudited: completedAudit.recordsAudited, omittedRecords: completedAudit.omittedRecords, totalEligible: completedAudit.totalEligible, skippedBefore: completedAudit.skippedBefore, moreRecords: completedAudit.moreRecords, applyResult, selectedActionCount: applyPlan.actions.length, selectedActionIndexes });
            atomicWriteFileSync(completedAudit.reportPath, report.trim() + "\n");
            updateProjectState(ctx.cwd, { lastAuditAppliedAt: nowIso(), lastAuditApplied: applyResult.applied, lastAuditSkipped: applyResult.skipped.length });
            updateMemoryChrome(ctx);
            ctx.ui.notify(`memory audit applied ${applyPlan.actions.length}/${actionCount} action${applyPlan.actions.length === 1 ? "" : "s"} (${applyResult.applied} record write${applyResult.applied === 1 ? "" : "s"}); skipped ${applyResult.skipped.length}; report ${completedAudit.reportPath}`, "info");
          });
        } else {
          ctx.ui.notify(`memory audit proposed ${actionCount} change${actionCount === 1 ? "" : "s"}; report ${completedAudit.reportPath}${options.dryRun || selectedActionIndexes?.length === 0 ? " (preview only)" : ""}`, "info");
        }
      } catch (err) {
        ctx.ui.notify(`memory audit failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      } finally {
        updateMemoryChrome(ctx);
      }
    },
  });

  pi.registerCommand("hmemory-review", {
    description: "Review active memories in a compact TUI overlay",
    handler: async (_args, ctx) => {
      let selected = 0;
      const load = () => activeRecords(latestRecordsForCwd(ctx.cwd))
        .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.salience - a.salience || b.updatedAt.localeCompare(a.updatedAt));
      let records = load();
      await ctx.ui.custom((tui, theme, keybindings, done) => ({
        render: (width: number) => buildReviewLines(records, selected, theme, width),
        invalidate: () => {},
        handleInput: (data: string) => {
          if (data === "q" || data === "Q" || keybindings.matches(data, "tui.select.cancel")) return done(undefined);
          if (data === "j" || keybindings.matches(data, "tui.select.down")) selected = Math.min(records.length - 1, selected + 1);
          else if (data === "k" || keybindings.matches(data, "tui.select.up")) selected = Math.max(0, selected - 1);
          else if (records[selected] && ["p", "u", "s", "d"].includes(data)) {
            const rec = records[selected]!;
            const patch: Partial<MemoryRecord> = data === "p" ? { pinned: true } : data === "u" ? { pinned: false } : data === "s" ? { status: "stale" } : { status: "done" };
            void withHybridMemoryMutation(ctx.cwd, async () => updateRecord(ctx.cwd, rec.id, patch, rec.scope))
              .catch((err) => ctx.ui.notify(`memory review update failed: ${err instanceof Error ? err.message : String(err)}`, "error"))
              .finally(() => {
                records = load();
                selected = Math.max(0, Math.min(selected, records.length - 1));
                updateMemoryChrome(ctx);
                tui.requestRender();
              });
            return;
          }
          records = load();
          selected = Math.max(0, Math.min(selected, records.length - 1));
          updateMemoryChrome(ctx);
          tui.requestRender();
        },
      }), { overlay: true, overlayOptions: { width: "62%", minWidth: 76, maxHeight: "82%", anchor: "top-center", offsetY: 2, margin: 1 } });
      updateMemoryChrome(ctx);
    },
  });

  pi.registerCommand("hmemory-repo", {
    description: "Search repo map files, symbols, commands, tools, hooks, and imports",
    handler: async (args, ctx) => {
      const q = args.trim();
      if (!q) return ctx.ui.notify("Usage: /hmemory-repo <query>", "error");
      const stale = repoMapStaleness(ctx.cwd);
      const out = repoExcerpt(ctx.cwd, q);
      ctx.ui.notify(`${stale.stale ? `repo map stale: ${stale.reason}\n` : ""}${out || "No repo map hits."}`, "info");
    },
  });

  pi.registerCommand("hmemory-context", {
    description: "Regenerate/show the compact working context file",
    handler: async (_args, ctx) => {
      await withHybridMemoryMutation(ctx.cwd, async () => {
        const map = readRepoMap(ctx.cwd);
        regenerateProjectContext(ctx.cwd, map, repoMapStaleness(ctx.cwd, map));
      });
      updateMemoryChrome(ctx);
      ctx.ui.notify(`working context: ${join(projectMemoryDir(ctx.cwd), CONTEXT)}`, "info");
    },
  });

  pi.registerCommand("hmemory-work", {
    description: "Create an active work item: /hmemory-work <description>",
    handler: async (args, ctx) => {
      const content = args.trim();
      if (!content) return ctx.ui.notify("Usage: /hmemory-work <description>", "error");
      await withHybridMemoryMutation(ctx.cwd, async () => {
        const ts = nowIso();
        const rec: MemoryRecord = { id: safeId("work_item", redactSecrets(content)), schemaVersion: 1, scope: "project", kind: "work_item", subject: compactText(redactSecrets(content), 64), content, tags: ["active-work"], status: "active", salience: 4, createdAt: ts, updatedAt: ts };
        const stored = appendRecord(ctx.cwd, rec);
        ctx.ui.notify(`work item created: ${recordKey(stored)}`, "info");
      });
      updateMemoryChrome(ctx);
    },
  });

  pi.registerCommand("hmemory-done", {
    description: "Mark a memory/work item done: /hmemory-done <id>",
    handler: async (args, ctx) => {
      const id = args.trim().split(/\s+/)[0];
      if (!id) return ctx.ui.notify("Usage: /hmemory-done <id>", "error");
      await withHybridMemoryMutation(ctx.cwd, async () => {
        const result = updateRecord(ctx.cwd, id, { status: "done" });
        ctx.ui.notify(updateResultText(result, id, "-> done"), result.updated ? "info" : "error");
      });
      updateMemoryChrome(ctx);
    },
  });

  pi.registerCommand("hmemory-pin", {
    description: "Pin a memory record: /hmemory-pin <id>",
    handler: async (args, ctx) => {
      const id = args.trim().split(/\s+/)[0];
      if (!id) return ctx.ui.notify("Usage: /hmemory-pin <id>", "error");
      await withHybridMemoryMutation(ctx.cwd, async () => {
        const result = updateRecord(ctx.cwd, id, { pinned: true });
        ctx.ui.notify(updateResultText(result, id, "pinned"), result.updated ? "info" : "error");
      });
      updateMemoryChrome(ctx);
    },
  });

  pi.registerCommand("hmemory-unpin", {
    description: "Unpin a memory record: /hmemory-unpin <id>",
    handler: async (args, ctx) => {
      const id = args.trim().split(/\s+/)[0];
      if (!id) return ctx.ui.notify("Usage: /hmemory-unpin <id>", "error");
      await withHybridMemoryMutation(ctx.cwd, async () => {
        const result = updateRecord(ctx.cwd, id, { pinned: false });
        ctx.ui.notify(updateResultText(result, id, "unpinned"), result.updated ? "info" : "error");
      });
      updateMemoryChrome(ctx);
    },
  });

  pi.registerCommand("hmemory-dashboard", {
    description: "Open a styled hybrid-memory dashboard overlay; add 'full' for details",
    handler: async (args, ctx) => {
      const detailed = /\b(full|details|verbose)\b/i.test(args);
      await ctx.ui.custom((_tui, theme, _kb, done) => ({
        render: (width: number) => buildDashboardLines(ctx.cwd, theme, width, detailed),
        invalidate: () => {},
        handleInput: (data: string) => { if (data === "q" || data === "Q" || data === "\x1b") done(undefined); },
      }), { overlay: true, overlayOptions: { width: "80%", minWidth: 60, maxHeight: "70%", anchor: "center", margin: 1 } });
      updateMemoryChrome(ctx);
    },
  });

  pi.registerCommand("hmemory-files", {
    description: "Show hybrid memory storage files",
    handler: async (_args, ctx) => {
      const p = paths(ctx.cwd);
      ctx.ui.notify(`user: ${p.user}\nproject: ${p.project}\nrepo map: ${join(p.project, REPOMAP)}\ncontext: ${join(p.project, CONTEXT)}`, "info");
    },
  });

  pi.registerCommand("hmemory-explain", {
    description: "Explain and preview memory selected for a prompt: /hmemory-explain <prompt>",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) return ctx.ui.notify("Usage: /hmemory-explain <prompt>", "error");
      const explanation = explainMemorySelection(ctx.cwd, query);
      const candidates = explanation.candidates.length
        ? explanation.candidates.map((item) => `- ${item.id} [${item.kind}; score ${item.score}${item.pinned ? "; pinned" : ""}]: ${item.subject}`).join("\n")
        : "- none";
      ctx.ui.notify(`memory selection: ${explanation.chars}/${explanation.maxChars} chars; ${explanation.candidates.length} candidate(s)\n${candidates}\n\n${explanation.block || "No memory block would be injected."}`, "info");
    },
  });
}
