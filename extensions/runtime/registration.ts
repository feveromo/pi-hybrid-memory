import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { HYBRID_MEMORY_CONTEXT_TYPE, HYBRID_MEMORY_TOOL_NAMES, HYBRID_MEMORY_TOOL_NAME_SET, paths, withHybridMemoryMutation, initializeDir } from "./foundation.ts";
import { hybridMemoryConfig, hybridMemoryEnabled } from "./configuration.ts";
import { repoMapStalenessCached, regenerateProjectContext } from "./repo-context.ts";
import { autoCapturePromptMemory, mineSummary } from "./sessions.ts";

import { autoImportCurrentSession, cheapStartupRefresh } from "./lifecycle.ts";
import { activeCounts, latestUserPromptFromMessages, buildInjection } from "./presentation-retrieval.ts";

import { registerMemoryCommands } from "./register-commands.ts";
import { registerMemoryTools } from "./register-tools.ts";

export default function (pi: ExtensionAPI) {
  const lastPromptByCwd = new Map<string, string>();

  function applyHybridMemoryToolState(ctx: any, activate = false) {
    if (typeof (pi as any).getActiveTools !== "function" || typeof (pi as any).setActiveTools !== "function") return;
    const active = ((pi as any).getActiveTools() ?? []) as string[];
    if (!hybridMemoryEnabled(ctx.cwd)) {
      const next = active.filter((name) => !HYBRID_MEMORY_TOOL_NAME_SET.has(name));
      if (next.length !== active.length) (pi as any).setActiveTools(next);
      return;
    }
    if (!activate) return;
    const allTools = typeof (pi as any).getAllTools === "function" ? ((pi as any).getAllTools() ?? []).map((tool: any) => tool.name) : HYBRID_MEMORY_TOOL_NAMES;
    const all = new Set<string>(allTools);
    const next = new Set(active);
    for (const name of HYBRID_MEMORY_TOOL_NAMES) if (all.has(name)) next.add(name);
    const nextList = [...next];
    if (nextList.length !== active.length || nextList.some((name, index) => name !== active[index])) (pi as any).setActiveTools(nextList);
  }

  function updateMemoryChrome(ctx: any) {
    ctx.ui.setStatus("hybrid-memory", undefined);
    if (!hybridMemoryEnabled(ctx.cwd)) {
      ctx.ui.setStatus("hybrid-memory-compact", `${ctx.ui.theme.fg("muted", "🧠")} ${ctx.ui.theme.fg("dim", "off")}`);
      return;
    }
    const counts = activeCounts(ctx.cwd);
    const stale = repoMapStalenessCached(ctx.cwd);
    const icon = stale.stale ? ctx.ui.theme.fg("warning", "🧠") : ctx.ui.theme.fg("accent", "🧠");
    const active = `${icon}${ctx.ui.theme.fg("success", String(counts.active))} ${ctx.ui.theme.fg("dim", "active")}`;
    const user = counts.user ? `${ctx.ui.theme.fg("muted", String(counts.user))} ${ctx.ui.theme.fg("dim", "user")}` : "";
    const project = counts.project ? `${ctx.ui.theme.fg("accent", String(counts.project))} ${ctx.ui.theme.fg("dim", "project")}` : "";
    const scopes = [user, project].filter(Boolean).join("/");
    const pinned = counts.pinned ? ctx.ui.theme.fg("warning", `📌${counts.pinned} pinned`) : "";
    const repo = stale.stale ? ctx.ui.theme.fg("warning", "stale") : ctx.ui.theme.fg("success", "fresh");
    ctx.ui.setStatus("hybrid-memory-compact", [active, scopes, pinned, repo].filter(Boolean).join(" "));
  }

  const clearRemovedWidget = (ctx: any) => ctx.ui.setWidget?.("hybrid-memory", undefined);

  pi.on("session_start", async (_event, ctx) => {
    clearRemovedWidget(ctx);
    applyHybridMemoryToolState(ctx);
    if (!hybridMemoryEnabled(ctx.cwd)) {
      updateMemoryChrome(ctx);
      return;
    }
    try {
      await withHybridMemoryMutation(ctx.cwd, async () => {
        const p = paths(ctx.cwd);
        initializeDir(p.user, "user");
        initializeDir(p.project, "project");
        const result = cheapStartupRefresh(ctx.cwd, ctx.sessionManager.getSessionFile?.());
        if (result.builtMap || result.sessions.written) {
          ctx.ui.notify(`hybrid memory startup: ${result.builtMap ? `repo map ${result.repoFiles} files; ` : ""}sessions scanned ${result.sessions.scanned}, wrote ${result.sessions.written}`, "info");
        } else if (result.skippedRepoMap) {
          ctx.ui.notify("hybrid memory: repo map missing/stale; run /hmemory-refresh or /hmemory-bootstrap when ready", "info");
        }
      });
    } catch (err) {
      await withHybridMemoryMutation(ctx.cwd, async () => regenerateProjectContext(ctx.cwd));
      ctx.ui.notify(`hybrid memory startup skipped: ${err instanceof Error ? err.message : String(err)}`, "info");
    }
    updateMemoryChrome(ctx);
  });

  pi.on("resources_discover", async (_event, ctx) => {
    clearRemovedWidget(ctx);
  });

  pi.on("session_compact", async (event: any, ctx) => {
    if (!hybridMemoryEnabled(ctx.cwd)) return;
    const entry = event.compactionEntry ?? event.entry ?? event.compaction;
    const result = await withHybridMemoryMutation(ctx.cwd, async () => mineSummary(ctx.cwd, entry?.summary, "compaction", { entryId: entry?.id, firstKeptEntryId: entry?.firstKeptEntryId, tokensBefore: entry?.tokensBefore }));
    if (result.written) {
      updateMemoryChrome(ctx);
      ctx.ui.notify(`hybrid memory mined compaction: ${result.written}/${result.extracted} records`, "info");
    }
  });

  pi.on("session_tree", async (event: any, ctx) => {
    if (!hybridMemoryEnabled(ctx.cwd)) return;
    const entry = event.summaryEntry ?? event.branchSummaryEntry ?? event.summary;
    const result = await withHybridMemoryMutation(ctx.cwd, async () => mineSummary(ctx.cwd, entry?.summary, "branch_summary", { entryId: entry?.id, fromId: entry?.fromId, newLeafId: event.newLeafId, oldLeafId: event.oldLeafId }));
    if (result.written) {
      updateMemoryChrome(ctx);
      ctx.ui.notify(`hybrid memory mined branch summary: ${result.written}/${result.extracted} records`, "info");
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    applyHybridMemoryToolState(ctx);
    lastPromptByCwd.set(ctx.cwd, event.prompt);
    if (!hybridMemoryEnabled(ctx.cwd)) return;
    const capture = await withHybridMemoryMutation(ctx.cwd, async () => autoCapturePromptMemory(ctx.cwd, event.prompt));
    if (capture.written) updateMemoryChrome(ctx);
  });

  pi.on("context", async (event, ctx) => {
    const messages = event.messages.filter((m) => (m as { customType?: string }).customType !== HYBRID_MEMORY_CONTEXT_TYPE);
    const config = hybridMemoryConfig(ctx.cwd);
    if (!config.enabled) return messages.length === event.messages.length ? undefined : { messages: messages as any };
    const block = buildInjection(ctx.cwd, latestUserPromptFromMessages(messages) || lastPromptByCwd.get(ctx.cwd) || "", config);
    if (!block) return messages.length === event.messages.length ? undefined : { messages: messages as any };
    return {
      messages: [{ role: "custom", customType: HYBRID_MEMORY_CONTEXT_TYPE, content: block.trim(), display: false, timestamp: Date.now() }, ...messages] as any,
    };
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!hybridMemoryEnabled(ctx.cwd)) return;
    const result = await withHybridMemoryMutation(ctx.cwd, async () => autoImportCurrentSession(ctx.cwd, ctx.sessionManager.getSessionFile?.()));
    if (result.written) updateMemoryChrome(ctx);
  });

  registerMemoryCommands(pi, { updateMemoryChrome, applyHybridMemoryToolState });
  registerMemoryTools(pi, { updateMemoryChrome });
}
