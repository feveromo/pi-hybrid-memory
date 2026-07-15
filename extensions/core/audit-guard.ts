export type AuditSnapshotRecord = {
  key: string;
  scope: string;
  kind: string;
  status: string;
  updatedAt: string;
};

export type AuditConstraints = {
  records: Readonly<Record<string, AuditSnapshotRecord>>;
  scopes: readonly string[];
  kinds: readonly string[];
};

export function buildAuditConstraints(records: readonly AuditSnapshotRecord[]): AuditConstraints {
  return {
    records: Object.fromEntries(records.map((record) => [record.key, { ...record }])),
    scopes: [...new Set(records.map((record) => record.scope))],
    kinds: [...new Set(records.map((record) => record.kind))],
  };
}

export function auditTargetRejection(
  constraints: AuditConstraints,
  requestedKey: string,
  current: AuditSnapshotRecord | undefined,
): string | undefined {
  const expected = constraints.records[requestedKey];
  if (!expected) return "record was not included in the audited packet";
  if (!current) return "record no longer exists";
  if (current.key !== requestedKey) return `resolved to ${current.key}, not the audited record`;
  if (current.status !== "active") return `record is now ${current.status}`;
  if (current.updatedAt !== expected.updatedAt) return "record changed after the audit packet was created";
  if (current.scope !== expected.scope || current.kind !== expected.kind) return "record scope or kind changed after audit";
  return undefined;
}

export function auditCreateRejection(constraints: AuditConstraints, scope: string | undefined, kind: string | undefined): string | undefined {
  if (!scope || !constraints.scopes.includes(scope)) return "scope was not represented in the audited packet";
  if (!kind || !constraints.kinds.includes(kind)) return "kind was not represented in the audited packet";
  return undefined;
}

export function auditMergeRejection(
  sources: readonly AuditSnapshotRecord[],
  proposedScope: string | undefined,
  proposedKind: string | undefined,
): string | undefined {
  if (sources.length < 2) return "merge needs at least two audited records";
  const scope = sources[0]?.scope;
  const kind = sources[0]?.kind;
  if (!scope || sources.some((source) => source.scope !== scope)) return "cross-scope merges are not allowed";
  if (!kind || sources.some((source) => source.kind !== kind)) return "cross-kind merges are not allowed";
  if (proposedScope && proposedScope !== scope) return `merge scope must remain ${scope}`;
  if (proposedKind && proposedKind !== kind) return `merge kind must remain ${kind}`;
  return undefined;
}
