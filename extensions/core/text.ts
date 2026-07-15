export function textParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (part && typeof part === "object" && "type" in part && (part as { type?: string }).type === "text") {
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    }
    return [];
  });
}

export function compactText(text: string, max = 220) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  const hard = Math.max(1, max - 1);
  const window = oneLine.slice(0, hard);
  const minBoundary = Math.floor(hard * 0.65);
  const boundary = [". ", "; ", ", ", " — ", " - ", " "]
    .map((needle) => window.lastIndexOf(needle))
    .filter((index) => index >= minBoundary)
    .sort((a, b) => b - a)[0];
  const clipped = window.slice(0, boundary ?? hard).replace(/[\s,;:.-]+$/g, "");
  return `${clipped || window.trimEnd()}…`;
}

export function cleanArgToken(token: string) {
  return token.replace(/^(["'])(.*)\1$/, "$2");
}
