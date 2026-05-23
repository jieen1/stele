/**
 * Expand brace expressions like `{a,b,c}` into separate patterns.
 * Supports nested braces.
 *
 * Shared utility — used by graph.ts, cli module-map.ts, and cli glob.ts.
 */
export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open === -1) return [pattern];

  const close = pattern.indexOf("}", open);
  if (close === -1) return [pattern];

  const before = pattern.slice(0, open);
  const after = pattern.slice(close + 1);
  const alternatives = pattern.slice(open + 1, close).split(",");

  return alternatives.flatMap((alt) => expandBraces(before + alt + after));
}
