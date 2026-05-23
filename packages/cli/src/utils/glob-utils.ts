/**
 * Expand brace expressions like `{a,b,c}` into separate patterns.
 * Supports nested braces.
 *
 * Shared utility within the CLI package. Cannot be imported from
 * @stele/architecture-core due to ddd-context-map architecture constraints
 * (cli-infrastructure may not depend on architecture-internal).
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
