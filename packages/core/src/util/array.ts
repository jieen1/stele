// Round 9 P-01: `String.prototype.localeCompare()` reads ICU/host
// locale and produces different orderings on machines with different
// LANG settings. That cracks determinism in the generator and the
// manifest hash. Use this helper everywhere instead — it is a pure
// code-point comparison that is locale-independent.
//
// Behaviour: returns -1 / 0 / 1 like localeCompare, but uses the
// JavaScript `<`/`>` operators which compare UTF-16 code units. The
// CORE_ENGINE_PURITY family of dogfood checkers bans bare
// `.localeCompare(` outside this file via NO_BARE_LOCALECOMPARE.
export function stableStringCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function uniqueSortedStrings(values: string[]): string[] {
  return [...new Set(values)].sort(stableStringCompare);
}
