import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { CancellableLoader, Container, Spacer, Text } from "@earendil-works/pi-tui";

import { compactText } from "../core/text.ts";
import { auditActionPreview, auditFilterLabel, auditReason, type MemoryAuditFilters, type MemoryAuditProgress, type MemoryAuditResult } from "./audit.ts";
import { bold, warp, clip, padVisible, centerVisible, reviewPanelBg } from "./presentation-retrieval.ts";

type MemoryAuditProgressHandle = {
  component: { render(width: number): string[]; invalidate(): void; handleInput(data: string): void; dispose(): void };
  signal: AbortSignal;
  setOnAbort(fn: (() => void) | undefined): void;
  update(progress: MemoryAuditProgress): void;
};

const MEMORY_AUDIT_STEPS: Array<[MemoryAuditProgress["stage"], string]> = [
  ["packet", "Build packet"],
  ["auth", "Check model"],
  ["model", "Ask model"],
  ["parse", "Parse plan"],
  ["report", "Save report"],
  ["done", "Ready"],
];

function auditStageTitle(stage: MemoryAuditProgress["stage"]) {
  switch (stage) {
    case "packet": return "Building redacted memory packet…";
    case "auth": return "Checking selected Pi model…";
    case "model": return "Waiting for model cleanup plan…";
    case "parse": return "Parsing and validating model plan…";
    case "report": return "Saving audit report…";
    case "done": return "Audit plan ready.";
  }
}

function auditProgressSteps(theme: any, stage: MemoryAuditProgress["stage"]) {
  const current = Math.max(0, MEMORY_AUDIT_STEPS.findIndex(([key]) => key === stage));
  return MEMORY_AUDIT_STEPS.map(([_key, label], index) => {
    const mark = index < current ? theme.fg("success", "✓") : index === current ? theme.fg("accent", "●") : theme.fg("dim", "○");
    const text = index <= current ? theme.fg(index < current ? "success" : "accent", label) : theme.fg("dim", label);
    return `${mark} ${text}`;
  }).join("  ");
}

function auditProgressDetail(theme: any, progress: MemoryAuditProgress, model: string, filters: Partial<MemoryAuditFilters> = {}, startedAt = Date.now()) {
  const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const bits = [
    `${theme.fg("dim", "model")} ${theme.fg("accent", model)}`,
    `${theme.fg("dim", "focus")} ${auditFilterLabel(filters)}`,
    `${theme.fg("dim", "elapsed")} ${elapsed}s`,
  ];
  if (typeof progress.recordsAudited === "number") bits.push(`${theme.fg("dim", "records")} ${theme.fg("success", String(progress.recordsAudited))}${progress.omittedRecords ? theme.fg("warning", ` (+${progress.omittedRecords} capped)`) : ""}`);
  if (typeof progress.actions === "number") bits.push(`${theme.fg("dim", "actions")} ${theme.fg(progress.actions ? "warning" : "muted", String(progress.actions))}`);
  const lines = [bits.join("  •  ")];
  if (progress.detail) lines.push(progress.detail);
  if (progress.reportPath) lines.push(`${theme.fg("dim", "report")} ${compactText(progress.reportPath, 140)}`);
  return lines.join("\n");
}

export function createMemoryAuditProgress(tui: any, theme: any, model: string, filters: Partial<MemoryAuditFilters> = {}): MemoryAuditProgressHandle {
  const startedAt = Date.now();
  let progress: MemoryAuditProgress = { stage: "packet", detail: "Collecting active memories, duplicate hints, and repo-map freshness." };
  const borderColor = (text: string) => theme.fg("border", text);
  const container = new Container();
  const loader = new CancellableLoader(tui, (text: string) => theme.fg("accent", text), (text: string) => theme.fg("muted", text), auditStageTitle(progress.stage));
  const detail = new Text("", 1, 0);
  const steps = new Text("", 1, 0);
  const hint = new Text(theme.fg("dim", "escape/ctrl+c cancel  •  no memory changes until the validated plan is applied"), 1, 0);
  const refresh = () => {
    loader.setMessage(auditStageTitle(progress.stage));
    detail.setText(auditProgressDetail(theme, progress, model, filters, startedAt));
    steps.setText(auditProgressSteps(theme, progress.stage));
  };
  container.addChild(new DynamicBorder(borderColor));
  container.addChild(new Text(theme.fg("accent", theme.bold ? theme.bold("🧠 Memory Audit") : "🧠 Memory Audit"), 1, 0));
  container.addChild(loader);
  container.addChild(detail);
  container.addChild(new Spacer(1));
  container.addChild(steps);
  container.addChild(new Spacer(1));
  container.addChild(hint);
  container.addChild(new DynamicBorder(borderColor));
  const timer = setInterval(() => {
    refresh();
    tui.requestRender();
  }, 1000);
  refresh();
  return {
    component: {
      render: (width: number) => container.render(width),
      invalidate: () => {
        container.invalidate();
        refresh();
      },
      handleInput: (data: string) => loader.handleInput(data),
      dispose: () => {
        clearInterval(timer);
        loader.dispose();
      },
    },
    signal: loader.signal,
    setOnAbort: (fn) => { loader.onAbort = fn; },
    update: (next) => {
      progress = { ...progress, ...next };
      refresh();
      tui.requestRender();
    },
  };
}

const AUDIT_ACTION_REVIEW_ROWS = 10;

function buildAuditActionReviewLines(audit: MemoryAuditResult, selected: number, enabled: Set<number>, theme: any, width: number) {
  const actions = audit.plan.actions;
  const panelWidth = Math.max(76, Math.min(width, 110));
  const inner = Math.max(32, panelWidth - 4);
  const border = (left: string, fill: string, right: string) => reviewPanelBg(theme, warp.purple(left + fill.repeat(Math.max(0, panelWidth - 2)) + right));
  const row = (text: string, selectedRow = false) => reviewPanelBg(theme, ` ${padVisible(clip(text, inner), inner)} `, selectedRow);
  const divider = () => row(warp.faint("─".repeat(inner)));
  const title = `${warp.pink("✺")} ${warp.cyan(bold("Memory Audit Actions"))} ${warp.dim(`${enabled.size}/${actions.length} selected`)}`;
  const recordText = `${audit.recordsAudited}/${audit.totalEligible} records${audit.moreRecords ? ` • ${audit.moreRecords} more` : ""}`;
  const reportText = compactText(audit.reportPath, Math.max(24, inner - 18));
  const lines = [
    border("╭", "─", "╮"),
    row(`${title}  ${warp.faint(auditFilterLabel(audit.filters))}`),
    row(`${warp.dim("model")} ${warp.cyan(audit.model)}  ${warp.dim("records")} ${warp.green(recordText)}`),
    row(`${warp.dim("report")} ${warp.faint(reportText)}`),
    row(warp.dim("↑/k ↓/j move   space toggle   a all   n none   enter apply selected   q cancel")),
    divider(),
  ];
  const start = Math.max(0, Math.min(Math.max(0, actions.length - AUDIT_ACTION_REVIEW_ROWS), selected - Math.floor(AUDIT_ACTION_REVIEW_ROWS / 2)));
  const visible = actions.slice(start, start + AUDIT_ACTION_REVIEW_ROWS);
  for (let index = 0; index < AUDIT_ACTION_REVIEW_ROWS; index++) {
    const action = visible[index];
    if (!action) {
      lines.push(row(""));
      continue;
    }
    const absolute = start + index;
    const isSelected = absolute === selected;
    const marker = isSelected ? warp.cyan("▸") : warp.faint(" ");
    const check = enabled.has(absolute) ? warp.green("☑") : warp.faint("☐");
    const label = `${String(absolute + 1).padStart(2, " ")}. ${auditActionPreview(action)}`;
    lines.push(row(`${marker} ${check} ${isSelected ? warp.green(label) : label}`, isSelected));
  }
  lines.push(divider());
  const action = actions[selected];
  const details = action ? [
    `${warp.dim("type   ")} ${String(action.type ?? "unknown")}`,
    `${warp.dim("reason ")} ${auditReason(action)}`,
    `${warp.dim("effect ")} ${auditActionPreview(action)}`,
  ] : [warp.dim("No action selected."), "", ""];
  for (let index = 0; index < 3; index++) lines.push(row(details[index] ?? ""));
  lines.push(border("╰", "─", "╯"));
  return lines.map((line) => centerVisible(line, width));
}

export async function chooseMemoryAuditActionIndexes(ctx: any, audit: MemoryAuditResult): Promise<number[] | null> {
  if (!audit.plan.actions.length) return [];
  let selected = 0;
  const enabled = new Set(audit.plan.actions.map((_action, index) => index));
  const result = await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (value: number[] | null) => void) => ({
    render: (width: number) => buildAuditActionReviewLines(audit, selected, enabled, theme, width),
    invalidate: () => {},
    handleInput: (data: string) => {
      if (data === "q" || data === "Q" || data === "\x1b") return done(null);
      if (data === "j" || data === "\x1b[B") selected = Math.min(audit.plan.actions.length - 1, selected + 1);
      else if (data === "k" || data === "\x1b[A") selected = Math.max(0, selected - 1);
      else if (data === " ") enabled.has(selected) ? enabled.delete(selected) : enabled.add(selected);
      else if (data === "a" || data === "A") audit.plan.actions.forEach((_action, index) => enabled.add(index));
      else if (data === "n" || data === "N") enabled.clear();
      else if (data === "\r" || data === "\n") return done([...enabled].sort((a, b) => a - b));
      tui.requestRender();
    },
  }), { overlay: true, overlayOptions: { width: "70%", minWidth: 82, maxHeight: "82%", anchor: "top-center", offsetY: 2, margin: 1 } }) as number[] | null | undefined;
  return result ?? null;
}
