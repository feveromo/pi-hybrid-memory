export type JsonlPurgeResult = {
  contents: string;
  removed: number;
  uncertainLines: number[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function purgeScopedRecordVersions(contents: string, id: string, scope: string): JsonlPurgeResult {
  const kept: string[] = [];
  const uncertainLines: number[] = [];
  let removed = 0;
  const lines = contents.split(/\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isObject(value) && value.id === id && value.scope === scope) {
        removed++;
        continue;
      }
    } catch {
      // Memory ids use a restricted slug alphabet, so a literal occurrence is
      // enough to flag a damaged line that could be the requested record.
      if (line.includes(id)) uncertainLines.push(index + 1);
    }
    kept.push(line);
  }
  return {
    contents: kept.length ? `${kept.join("\n")}\n` : "",
    removed,
    uncertainLines,
  };
}
