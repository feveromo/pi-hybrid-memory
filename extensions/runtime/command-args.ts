import { kindEnum, scopeEnum, searchStatusEnum, type MemoryKind, type MemoryScope } from "../core/domain.ts";
import { redactSecrets } from "../core/privacy.ts";
import { cleanArgToken } from "../core/text.ts";
import { AUDIT_RECORD_LIMIT } from "./foundation.ts";
import { type SearchRecordsOptions, type SearchStatusFilter } from "./retrieval.ts";
import { boundedNumber } from "./sessions.ts";

function parseAuditActionIndexes(value: string | undefined) {
  const indexes = new Set<number>();
  for (const part of String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Math.max(1, Math.min(20, Number(range[1])));
      const end = Math.max(1, Math.min(20, Number(range[2])));
      for (let index = Math.min(start, end); index <= Math.max(start, end); index++) indexes.add(index - 1);
      continue;
    }
    if (/^\d+$/.test(part)) indexes.add(Math.max(0, Math.min(19, Number(part) - 1)));
  }
  return [...indexes].sort((a, b) => a - b);
}

export function parseMemoryAuditArgs(args: string) {
  const tokens = args.match(/(?:"[^"]*"|'[^']*'|\S+)/g)?.map(cleanArgToken) ?? [];
  let apply = false;
  let dryRun = false;
  let scope: MemoryScope | undefined;
  let kind: MemoryKind | undefined;
  let page = 1;
  let limit = AUDIT_RECORD_LIMIT;
  let actionIndexes: number[] | undefined;
  const query: string[] = [];
  const readValue = (token: string, prefix: string, index: number) => token.includes("=") ? { value: token.slice(prefix.length + 1), nextIndex: index } : { value: tokens[index + 1], nextIndex: index + 1 };
  for (let index = 0; index < tokens.length; index++) {
    const clean = tokens[index]!;
    if (/^(?:--?apply|apply)$/i.test(clean)) apply = true;
    else if (/^(?:--?dry-run|--?preview|preview)$/i.test(clean)) dryRun = true;
    else if (clean.startsWith("--scope")) {
      const read = readValue(clean, "--scope", index); index = read.nextIndex;
      if (scopeEnum.includes(read.value as MemoryScope)) scope = read.value as MemoryScope;
    } else if (clean.startsWith("--kind")) {
      const read = readValue(clean, "--kind", index); index = read.nextIndex;
      if (kindEnum.includes(read.value as MemoryKind)) kind = read.value as MemoryKind;
    } else if (clean.startsWith("--page")) {
      const read = readValue(clean, "--page", index); index = read.nextIndex;
      page = boundedNumber(read.value, 1, 1, 1000);
    } else if (clean.startsWith("--limit")) {
      const read = readValue(clean, "--limit", index); index = read.nextIndex;
      limit = boundedNumber(read.value, AUDIT_RECORD_LIMIT, 1, AUDIT_RECORD_LIMIT);
    } else if (clean.startsWith("--actions") || clean.startsWith("--only")) {
      const prefix = clean.startsWith("--actions") ? "--actions" : "--only";
      const read = readValue(clean, prefix, index); index = read.nextIndex;
      actionIndexes = parseAuditActionIndexes(read.value);
    } else query.push(clean);
  }
  const trimmed = query.join(" ").trim();
  return { apply, dryRun, query: !trimmed || /^(?:all|active)$/i.test(trimmed) ? undefined : redactSecrets(trimmed), scope, kind, page, limit, actionIndexes };
}

export function parseMemorySearchArgs(args: string): { query: string; options: SearchRecordsOptions } {
  const tokens = args.match(/(?:"[^"]*"|'[^']*'|\S+)/g)?.map(cleanArgToken) ?? [];
  const query: string[] = [];
  const options: SearchRecordsOptions = {};
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const next = () => tokens[++index];
    const readValue = (prefix: string) => token.includes("=") ? token.slice(prefix.length + 1) : next();
    if (token === "--all" || token === "all" || token === "--include-inactive") options.status = "all";
    else if (token.startsWith("--scope")) {
      const value = readValue("--scope");
      if (scopeEnum.includes(value as MemoryScope)) options.scope = value as MemoryScope;
    } else if (token.startsWith("--kind")) {
      const value = readValue("--kind");
      if (kindEnum.includes(value as MemoryKind)) options.kind = value as MemoryKind;
    } else if (token.startsWith("--status")) {
      const value = readValue("--status");
      if (searchStatusEnum.includes(value as SearchStatusFilter)) options.status = value as SearchStatusFilter;
    } else {
      query.push(token);
    }
  }
  const text = redactSecrets(query.join(" ").trim());
  return { query: text || "active pinned", options };
}

export function parseMemoryDoctorArgs(args: string) {
  const tokens = args.match(/(?:"[^"]*"|'[^']*'|\S+)/g)?.map(cleanArgToken) ?? [];
  let mode: "preview" | "apply" = "preview";
  let maxActiveSessionRecaps: number | undefined;
  for (const token of tokens) {
    if (/^(?:--?apply|apply)$/i.test(token)) mode = "apply";
    else if (/^(?:--?preview|preview|--?dry-run)$/i.test(token)) mode = "preview";
    else if (/^--?max-recaps=/i.test(token)) maxActiveSessionRecaps = boundedNumber(token.split("=")[1], 12, 3, 100);
    else if (/^\d+$/.test(token)) maxActiveSessionRecaps = boundedNumber(token, 12, 3, 100);
  }
  return { mode, maxActiveSessionRecaps };
}
