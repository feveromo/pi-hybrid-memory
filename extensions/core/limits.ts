export const MEMORY_LIMITS = Object.freeze({
  id: 200,
  subject: 160,
  content: 4_000,
  tagCount: 24,
  tag: 80,
  filePathCount: 24,
  filePath: 1_024,
  symbolCount: 80,
  symbol: 200,
  supersedesCount: 24,
  evidenceEntries: 50,
  evidenceString: 2_000,
  searchQuery: 1_000,
  note: 1_000,
  sessionPath: 4_096,
});

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

export function boundedStrings(values: readonly string[] | undefined, maxItems: number, maxLength: number): string[] | undefined {
  if (!values) return undefined;
  return values.slice(0, maxItems).map((value) => truncateText(value, maxLength));
}
