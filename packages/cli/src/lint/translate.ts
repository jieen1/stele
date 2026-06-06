import type { AstNode, AtomNode, ListNode, InvariantDeclaration } from "@stele/core";

/**
 * PURE translator: CDL assert AST -> an internal SMT term IR.
 *
 * No z3, no I/O, no clock, no env, no filesystem. Deterministic: all outputs
 * are emitted in sorted (id / key) order. The soundness rule is paramount —
 * whenever any sub-expression cannot be faithfully encoded, the WHOLE
 * invariant is marked `ok:false` and excluded from analysis. We never emit an
 * approximate encoding that could yield a wrong verdict.
 *
 * See packages/cli docs / docs/spec/cdl.md "stele lint" for the spec.
 */

export type IrSort = "Int" | "Real" | "Bool" | "String";

export type IrTerm =
  // leaves
  | { kind: "pathVar"; key: string; sort: IrSort }
  | { kind: "intLit"; value: bigint }
  | { kind: "realLit"; raw: string }
  | { kind: "strLit"; value: string }
  | { kind: "boolLit"; value: boolean }
  // boolean connectives
  | { kind: "and"; args: IrTerm[] }
  | { kind: "or"; args: IrTerm[] }
  | { kind: "not"; arg: IrTerm }
  | { kind: "implies"; a: IrTerm; b: IrTerm }
  | { kind: "iff"; a: IrTerm; b: IrTerm }
  // relations
  | { kind: "eq"; a: IrTerm; b: IrTerm }
  | { kind: "neq"; a: IrTerm; b: IrTerm }
  | { kind: "cmp"; op: "gt" | "gte" | "lt" | "lte"; a: IrTerm; b: IrTerm }
  // arithmetic
  | { kind: "arith"; op: "add" | "sub" | "mul" | "neg" | "abs"; args: IrTerm[] };

export type TranslatedInvariant =
  | { id: string; ok: true; term: IrTerm }
  | { id: string; ok: false; reason: string };

export type SortConflict = { key: string; sorts: IrSort[] };

export type TranslationResult = {
  translated: TranslatedInvariant[];
  pathSorts: ReadonlyMap<string, IrSort>;
  conflicts: ReadonlyArray<SortConflict>;
};

/** A translation candidate carries an `assertExpression` and no `usesChecker`. */
export function isTranslationCandidate(invariant: InvariantDeclaration): boolean {
  return invariant.assertExpression !== undefined && invariant.usesChecker === undefined;
}

// ---------------------------------------------------------------------------
// Sort inference lattice
// ---------------------------------------------------------------------------

type InfSort = IrSort | "Numeric" | "Unknown";

type KeyState = {
  // accumulated constraint after union-find collapse
  sort: InfSort;
  realWitness: boolean; // a non-integral literal met this numeric key
  conflict: boolean;
  conflictSorts: Set<IrSort>;
};

class SortTable {
  readonly #parent = new Map<string, string>();
  readonly #state = new Map<string, KeyState>();

  ensure(key: string): void {
    if (!this.#parent.has(key)) {
      this.#parent.set(key, key);
      this.#state.set(key, { sort: "Unknown", realWitness: false, conflict: false, conflictSorts: new Set() });
    }
  }

  find(key: string): string {
    this.ensure(key);
    let root = key;
    while (this.#parent.get(root) !== root) {
      root = this.#parent.get(root)!;
    }
    // path compression for determinism-neutral speedup
    let cur = key;
    while (this.#parent.get(cur) !== root) {
      const next = this.#parent.get(cur)!;
      this.#parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // canonical root = lexicographically smaller key (determinism)
    const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
    const dropState = this.#state.get(drop)!;
    this.#parent.set(drop, keep);
    this.#merge(keep, dropState);
  }

  #merge(rootKey: string, incoming: KeyState): void {
    const root = this.find(rootKey);
    const state = this.#state.get(root)!;
    state.realWitness ||= incoming.realWitness;
    state.conflict ||= incoming.conflict;
    for (const s of incoming.conflictSorts) state.conflictSorts.add(s);
    state.sort = combineInfSort(state, incoming.sort);
  }

  constrain(key: string, sort: InfSort, realWitness = false): void {
    const root = this.find(key);
    const state = this.#state.get(root)!;
    if (realWitness) state.realWitness = true;
    state.sort = combineInfSort(state, sort);
  }

  /** Resolve every key to a concrete sort, recording conflicts. */
  resolve(): { sorts: Map<string, IrSort>; conflictRoots: Map<string, IrSort[]> } {
    const sorts = new Map<string, IrSort>();
    const conflictRoots = new Map<string, IrSort[]>();
    for (const key of this.#parent.keys()) {
      const root = this.find(key);
      const state = this.#state.get(root)!;
      if (state.conflict) {
        conflictRoots.set(root, [...state.conflictSorts].sort());
        continue;
      }
      const concrete = resolveConcrete(state);
      if (concrete === undefined) {
        // Unknown -> unresolved; we leave it absent (callers detect).
        continue;
      }
      sorts.set(key, concrete);
    }
    return { sorts, conflictRoots };
  }

  rootOf(key: string): string {
    return this.find(key);
  }

  hasConflict(key: string): boolean {
    const state = this.#state.get(this.find(key))!;
    return state.conflict;
  }

  isUnknown(key: string): boolean {
    const state = this.#state.get(this.find(key))!;
    return !state.conflict && resolveConcrete(state) === undefined;
  }
}

function combineInfSort(state: KeyState, incoming: InfSort): InfSort {
  const current = state.sort;
  if (incoming === "Unknown") return current;
  if (current === "Unknown") return incoming;
  if (current === incoming) return current;

  const isNumericish = (s: InfSort): boolean => s === "Numeric" || s === "Int" || s === "Real";

  if (isNumericish(current) && isNumericish(incoming)) {
    // Int + Real / Numeric all collapse to a numeric component; Real witness
    // is tracked separately. Keep the most concrete (Real > Int > Numeric).
    if (current === "Real" || incoming === "Real") return "Real";
    if (current === "Int" || incoming === "Int") return "Int";
    return "Numeric";
  }

  // genuine conflict (Numeric+String, Bool+String, Bool+Numeric, etc.)
  state.conflict = true;
  recordConflictSort(state, current);
  recordConflictSort(state, incoming);
  return current;
}

function recordConflictSort(state: KeyState, sort: InfSort): void {
  if (sort === "Int" || sort === "Real" || sort === "Bool" || sort === "String") {
    state.conflictSorts.add(sort);
  } else if (sort === "Numeric") {
    // represent an undecided numeric witness as Int for reporting
    state.conflictSorts.add("Int");
  }
}

function resolveConcrete(state: KeyState): IrSort | undefined {
  switch (state.sort) {
    case "Unknown":
      return undefined;
    case "Numeric":
    case "Int":
    case "Real":
      // Numeric paths resolve to Real — the wide domain. We cannot PROVE a field
      // is integer-only without a declared type source, and a contradiction
      // verdict is sound only over the widest plausible domain: unsat-over-Real
      // implies unsat-over-Int, so Real never produces a FALSE contradiction.
      // Defaulting to Int reported satisfiable open intervals (e.g. 0<rate<1) as
      // permanent contradictions — a wrong verdict the tool promises never to make.
      // (Tautology/redundancy over Real are likewise conservative: any warning
      // they emit holds over Int too; they may only MISS integer-only cases,
      // which is the safe direction for an advisory linter.)
      return "Real";
    case "Bool":
      return "Bool";
    case "String":
      return "String";
  }
}

// ---------------------------------------------------------------------------
// Path-variable canonical key (injective, deterministic)
// ---------------------------------------------------------------------------

/** "translatable" error: structural failure encountered during lowering. */
class Untranslatable extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

function atomSegment(node: AstNode): string {
  if (node.kind === "identifier") return node.value;
  if (node.kind === "keyword") return `:${node.value}`;
  throw new Untranslatable("malformed-path");
}

/** Canonical key for a `(path ...)` / `(field ...)` accessor. `/`-joined atom text. */
function pathKey(node: AstNode): string {
  if (node.kind !== "list") throw new Untranslatable("malformed-path");
  if (node.head === "path") {
    if (node.items.length === 0) throw new Untranslatable("malformed-path");
    return node.items.map(atomSegment).join("/");
  }
  if (node.head === "field") {
    const inner = node.items[0];
    const seg = node.items[1];
    if (inner === undefined || inner.kind !== "list" || (inner.head !== "path" && inner.head !== "field")) {
      throw new Untranslatable("malformed-path");
    }
    if (seg === undefined) throw new Untranslatable("malformed-path");
    return `${pathKey(inner)}/${atomSegment(seg)}`;
  }
  throw new Untranslatable("malformed-path");
}

// ---------------------------------------------------------------------------
// Operator closure
// ---------------------------------------------------------------------------

const BOOL_CONNECTIVES = new Set(["and", "or", "not", "implies", "iff", "when"]);
const RELATIONS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "between"]);
const ARITHMETIC = new Set(["add", "sub", "mul", "neg", "abs"]);

// ---------------------------------------------------------------------------
// Pass 1: structural validation + constraint collection
// ---------------------------------------------------------------------------

type ExprCtx = "Bool" | "Numeric" | "Value";

function isNumberLiteralReal(raw: string): boolean {
  return raw.includes(".") || raw.includes("e") || raw.includes("E");
}

function isListNode(node: AstNode): node is ListNode {
  return node.kind === "list";
}

function isPathAccess(node: AstNode): boolean {
  return isListNode(node) && (node.head === "path" || node.head === "field");
}

/**
 * Walk an assert expression in a given expected context, recording sort
 * constraints into `table`. Throws Untranslatable on any structural violation.
 * Records the set of path keys referenced (for membership / conflict exclusion).
 */
function collect(node: AstNode, ctx: ExprCtx, table: SortTable, refs: Set<string>): void {
  if (!isListNode(node)) {
    collectAtom(node, ctx);
    return;
  }

  if (isPathAccess(node)) {
    const key = pathKey(node);
    refs.add(key);
    table.ensure(key);
    if (ctx === "Numeric") table.constrain(key, "Numeric");
    else if (ctx === "Bool") table.constrain(key, "Bool");
    // ctx === "Value": no constraint here; equality handler imposes it
    return;
  }

  const head = node.head;

  if (BOOL_CONNECTIVES.has(head)) {
    collectBool(node, table, refs);
    return;
  }
  if (RELATIONS.has(head)) {
    collectRelation(node, table, refs);
    return;
  }
  if (ARITHMETIC.has(head)) {
    if (ctx === "Bool") throw new Untranslatable(`unsupported-operator: ${head}`);
    for (const item of node.items) collect(item, "Numeric", table, refs);
    return;
  }

  throw new Untranslatable(`unsupported-operator: ${head}`);
}

function collectAtom(node: AtomNode, ctx: ExprCtx): void {
  if (node.kind === "number") {
    if (!Number.isFinite(node.value)) throw new Untranslatable("bad-literal");
    return;
  }
  if (node.kind === "string") return;
  if (node.kind === "identifier") {
    if (node.value === "true" || node.value === "false") return;
    // a bare identifier in expression position is not a translatable leaf
    throw new Untranslatable("unsupported-operator: <atom>");
  }
  // keyword in value position
  throw new Untranslatable("unsupported-operator: <keyword>");
}

function collectBool(node: ListNode, table: SortTable, refs: Set<string>): void {
  for (const item of node.items) collect(item, "Bool", table, refs);
}

function collectRelation(node: ListNode, table: SortTable, refs: Set<string>): void {
  const head = node.head;
  if (head === "gt" || head === "gte" || head === "lt" || head === "lte") {
    const [a, b] = node.items;
    if (a === undefined || b === undefined) throw new Untranslatable("bad-literal");
    collect(a, "Numeric", table, refs);
    collect(b, "Numeric", table, refs);
    collectNumericComponent([a, b], table, refs);
    return;
  }
  if (head === "between") {
    const [x, lo, hi] = node.items;
    if (x === undefined || lo === undefined || hi === undefined) throw new Untranslatable("bad-literal");
    for (const item of [x, lo, hi]) collect(item, "Numeric", table, refs);
    collectNumericComponent([x, lo, hi], table, refs);
    return;
  }
  // eq / neq
  const [a, b] = node.items;
  if (a === undefined || b === undefined) throw new Untranslatable("bad-literal");
  collectEquality(a, b, table, refs);
}

/**
 * A numeric relation forms a connected component: every path key appearing in
 * its operands shares one numeric sort. Union them, and if any non-integral
 * literal appears anywhere in the operands, mark the component Real (Int+Real
 * is never a conflict — widen to Real). This makes cross-invariant numeric
 * sort inference sound.
 */
function collectNumericComponent(operands: AstNode[], table: SortTable, refs: Set<string>): void {
  const keys: string[] = [];
  let real = false;
  const visit = (n: AstNode): void => {
    if (isPathAccess(n)) {
      const key = pathKey(n);
      refs.add(key);
      table.ensure(key);
      table.constrain(key, "Numeric");
      keys.push(key);
      return;
    }
    if (isListNode(n)) {
      for (const it of n.items) visit(it);
      return;
    }
    if (n.kind === "number" && isNumberLiteralReal(n.raw)) real = true;
  };
  for (const op of operands) visit(op);

  for (let i = 1; i < keys.length; i += 1) table.union(keys[0]!, keys[i]!);
  if (real) {
    for (const key of keys) table.constrain(key, "Numeric", true);
  }
}

function collectEquality(a: AstNode, b: AstNode, table: SortTable, refs: Set<string>): void {
  const aPath = isPathAccess(a) ? pathKey(a) : undefined;
  const bPath = isPathAccess(b) ? pathKey(b) : undefined;
  if (aPath !== undefined) {
    refs.add(aPath);
    table.ensure(aPath);
  }
  if (bPath !== undefined) {
    refs.add(bPath);
    table.ensure(bPath);
  }

  // path vs path -> union
  if (aPath !== undefined && bPath !== undefined) {
    table.union(aPath, bPath);
    return;
  }

  const pathSide = aPath ?? bPath;
  const otherSide = aPath !== undefined ? b : bPath !== undefined ? a : undefined;

  if (pathSide !== undefined && otherSide !== undefined) {
    imposeEqualitySort(pathSide, otherSide, table, refs);
    return;
  }

  // neither side is a path: both must still be translatable leaves/exprs.
  // Recurse to validate structure (e.g. (eq (add ...) 5)).
  collect(a, "Value", table, refs);
  collect(b, "Value", table, refs);
}

function imposeEqualitySort(key: string, other: AstNode, table: SortTable, refs: Set<string>): void {
  if (isListNode(other)) {
    if (isPathAccess(other)) {
      const otherKey = pathKey(other);
      refs.add(otherKey);
      table.union(key, otherKey);
      return;
    }
    if (ARITHMETIC.has(other.head)) {
      table.constrain(key, "Numeric");
      collect(other, "Numeric", table, refs);
      return;
    }
    if (BOOL_CONNECTIVES.has(other.head) || RELATIONS.has(other.head)) {
      table.constrain(key, "Bool");
      collect(other, "Bool", table, refs);
      return;
    }
    throw new Untranslatable(`unsupported-operator: ${other.head}`);
  }
  if (other.kind === "string") {
    table.constrain(key, "String");
    return;
  }
  if (other.kind === "number") {
    if (!Number.isFinite(other.value)) throw new Untranslatable("bad-literal");
    table.constrain(key, "Numeric", isNumberLiteralReal(other.raw));
    return;
  }
  if (other.kind === "identifier" && (other.value === "true" || other.value === "false")) {
    table.constrain(key, "Bool");
    return;
  }
  throw new Untranslatable("unsupported-operator: <atom>");
}

// ---------------------------------------------------------------------------
// Pass 2: lowering AST -> IrTerm using resolved sorts
// ---------------------------------------------------------------------------

function lowerBool(node: AstNode, sorts: ReadonlyMap<string, IrSort>): IrTerm {
  if (!isListNode(node)) {
    if (node.kind === "identifier" && (node.value === "true" || node.value === "false")) {
      return { kind: "boolLit", value: node.value === "true" };
    }
    throw new Untranslatable("unsupported-operator: <atom>");
  }
  if (isPathAccess(node)) {
    return lowerPathVar(node, sorts);
  }
  const head = node.head;
  switch (head) {
    case "and":
      return { kind: "and", args: node.items.map((it) => lowerBool(it, sorts)) };
    case "or":
      return { kind: "or", args: node.items.map((it) => lowerBool(it, sorts)) };
    case "not":
      return { kind: "not", arg: lowerBool(req(node.items[0]), sorts) };
    case "implies":
      return { kind: "implies", a: lowerBool(req(node.items[0]), sorts), b: lowerBool(req(node.items[1]), sorts) };
    case "iff":
      return { kind: "iff", a: lowerBool(req(node.items[0]), sorts), b: lowerBool(req(node.items[1]), sorts) };
    case "when":
      return { kind: "implies", a: lowerBool(req(node.items[0]), sorts), b: lowerBool(req(node.items[1]), sorts) };
    case "eq":
    case "neq":
      return lowerEquality(head, req(node.items[0]), req(node.items[1]), sorts);
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return {
        kind: "cmp",
        op: head,
        a: lowerNumeric(req(node.items[0]), sorts),
        b: lowerNumeric(req(node.items[1]), sorts),
      };
    case "between": {
      const x = lowerNumeric(req(node.items[0]), sorts);
      const lo = lowerNumeric(req(node.items[1]), sorts);
      const hi = lowerNumeric(req(node.items[2]), sorts);
      return {
        kind: "and",
        args: [
          { kind: "cmp", op: "gte", a: x, b: lo },
          { kind: "cmp", op: "lte", a: x, b: hi },
        ],
      };
    }
    default:
      throw new Untranslatable(`unsupported-operator: ${head}`);
  }
}

function lowerEquality(head: "eq" | "neq", a: AstNode, b: AstNode, sorts: ReadonlyMap<string, IrSort>): IrTerm {
  const sort = unifiedEqualitySort(a, b, sorts);
  const at = lowerBySort(a, sort, sorts);
  const bt = lowerBySort(b, sort, sorts);
  return head === "eq" ? { kind: "eq", a: at, b: bt } : { kind: "neq", a: at, b: bt };
}

function unifiedEqualitySort(a: AstNode, b: AstNode, sorts: ReadonlyMap<string, IrSort>): IrSort {
  const sa = operandSort(a, sorts);
  const sb = operandSort(b, sorts);
  const s = sa ?? sb;
  if (s === undefined) throw new Untranslatable("unresolved-sort");
  if (sa !== undefined && sb !== undefined && sa !== sb) {
    // The numeric domain is unified to Real (see resolveConcrete): an integer
    // literal IS a real number, so a Real path compared to an Int literal (or
    // vice versa) is NOT a mismatch — widen the equality to Real. Only a
    // cross-FAMILY pair (numeric vs String, numeric vs Bool, …) is genuine.
    const numeric = (x: IrSort): boolean => x === "Int" || x === "Real";
    if (numeric(sa) && numeric(sb)) return "Real";
    throw new Untranslatable("eq-sort-mismatch");
  }
  return s;
}

function operandSort(node: AstNode, sorts: ReadonlyMap<string, IrSort>): IrSort | undefined {
  if (isPathAccess(node)) {
    return sorts.get(pathKey(node));
  }
  if (isListNode(node)) {
    if (ARITHMETIC.has(node.head)) return numericComponentSort(node, sorts);
    if (BOOL_CONNECTIVES.has(node.head) || RELATIONS.has(node.head)) return "Bool";
    throw new Untranslatable(`unsupported-operator: ${node.head}`);
  }
  if (node.kind === "string") return "String";
  if (node.kind === "number") return isNumberLiteralReal(node.raw) ? "Real" : "Int";
  if (node.kind === "identifier" && (node.value === "true" || node.value === "false")) return "Bool";
  return undefined;
}

/** Numeric sort of an arithmetic subtree: Real if any path/literal resolves Real. */
function numericComponentSort(node: AstNode, sorts: ReadonlyMap<string, IrSort>): IrSort {
  let real = false;
  const visit = (n: AstNode): void => {
    if (isPathAccess(n)) {
      if (sorts.get(pathKey(n)) === "Real") real = true;
      return;
    }
    if (isListNode(n)) {
      for (const it of n.items) visit(it);
      return;
    }
    if (n.kind === "number" && isNumberLiteralReal(n.raw)) real = true;
  };
  visit(node);
  return real ? "Real" : "Int";
}

function lowerBySort(node: AstNode, sort: IrSort, sorts: ReadonlyMap<string, IrSort>): IrTerm {
  if (isPathAccess(node)) {
    return { kind: "pathVar", key: pathKey(node), sort };
  }
  if (isListNode(node)) {
    if (sort === "Bool") return lowerBool(node, sorts);
    if (sort === "Int" || sort === "Real") return lowerNumeric(node, sorts);
    throw new Untranslatable("eq-sort-mismatch");
  }
  if (node.kind === "string") {
    if (sort !== "String") throw new Untranslatable("eq-sort-mismatch");
    return { kind: "strLit", value: node.value };
  }
  if (node.kind === "number") {
    if (sort === "Real") return { kind: "realLit", raw: node.raw };
    if (sort === "Int") {
      if (isNumberLiteralReal(node.raw)) throw new Untranslatable("eq-sort-mismatch");
      return { kind: "intLit", value: BigInt(node.raw) };
    }
    throw new Untranslatable("eq-sort-mismatch");
  }
  if (node.kind === "identifier" && (node.value === "true" || node.value === "false")) {
    if (sort !== "Bool") throw new Untranslatable("eq-sort-mismatch");
    return { kind: "boolLit", value: node.value === "true" };
  }
  throw new Untranslatable("unsupported-operator: <atom>");
}

function lowerNumeric(node: AstNode, sorts: ReadonlyMap<string, IrSort>): IrTerm {
  const sort = numericComponentSort(node, sorts);
  return lowerNumericIn(node, sort, sorts);
}

function lowerNumericIn(node: AstNode, sort: IrSort, sorts: ReadonlyMap<string, IrSort>): IrTerm {
  if (isPathAccess(node)) {
    const resolved = sorts.get(pathKey(node));
    if (resolved === undefined) throw new Untranslatable("unresolved-sort");
    if (resolved !== "Int" && resolved !== "Real") throw new Untranslatable("eq-sort-mismatch");
    return { kind: "pathVar", key: pathKey(node), sort: resolved };
  }
  if (isListNode(node)) {
    const head = node.head;
    if (!ARITHMETIC.has(head)) throw new Untranslatable(`unsupported-operator: ${head}`);
    const args = node.items.map((it) => lowerNumericIn(it, sort, sorts));
    return { kind: "arith", op: head as "add" | "sub" | "mul" | "neg" | "abs", args };
  }
  if (node.kind === "number") {
    if (sort === "Real") return { kind: "realLit", raw: node.raw };
    if (isNumberLiteralReal(node.raw)) {
      // a real literal inside an Int-typed component is a contradiction the
      // component-widener should have prevented; be defensive.
      return { kind: "realLit", raw: node.raw };
    }
    return { kind: "intLit", value: BigInt(node.raw) };
  }
  throw new Untranslatable("unsupported-operator: <atom>");
}

function lowerPathVar(node: ListNode, sorts: ReadonlyMap<string, IrSort>): IrTerm {
  const key = pathKey(node);
  const sort = sorts.get(key);
  if (sort === undefined) throw new Untranslatable("unresolved-sort");
  if (sort !== "Bool") throw new Untranslatable("eq-sort-mismatch");
  return { kind: "pathVar", key, sort };
}

function req(node: AstNode | undefined): AstNode {
  if (node === undefined) throw new Untranslatable("bad-literal");
  return node;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function translateContract(invariants: InvariantDeclaration[]): TranslationResult {
  const candidates = invariants
    .filter(isTranslationCandidate)
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Pass 0/1: structural validation + constraint collection. We record, per
  // candidate, either a local failure or the set of path keys it touches.
  const table = new SortTable();
  type Pass1 = { id: string; expr: AstNode; refs: Set<string> } | { id: string; reason: string };
  const pass1: Pass1[] = candidates.map((inv) => {
    const expr = inv.assertExpression!;
    const refs = new Set<string>();
    try {
      collect(expr, "Bool", table, refs);
      return { id: inv.id, expr, refs };
    } catch (error) {
      if (error instanceof Untranslatable) return { id: inv.id, reason: error.reason };
      throw error;
    }
  });

  // Resolve sorts contract-wide.
  const { sorts, conflictRoots } = table.resolve();

  // Build conflict reporting: map each conflicting root to a stable reason key.
  // The reason references the lexicographically-smallest member key of the
  // component so the message is deterministic.
  const conflicts: SortConflict[] = [...conflictRoots.entries()]
    .map(([root, srts]) => ({ key: root, sorts: srts }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // Pass 2: lower each surviving candidate; exclude any that references a
  // conflicting / unresolved key.
  const translated: TranslatedInvariant[] = pass1.map((entry) => {
    if ("reason" in entry) return { id: entry.id, ok: false, reason: entry.reason };

    // Global rule 5: conflicting sort exclusion.
    for (const key of [...entry.refs].sort()) {
      if (table.hasConflict(key)) {
        return { id: entry.id, ok: false, reason: `inconsistent-sort: ${conflictReportKey(table, key)}` };
      }
    }
    // Global rule 7: unresolved sort.
    for (const key of [...entry.refs].sort()) {
      if (table.isUnknown(key)) {
        return { id: entry.id, ok: false, reason: "unresolved-sort" };
      }
    }

    try {
      const term = lowerBool(entry.expr, sorts);
      return { id: entry.id, ok: true, term };
    } catch (error) {
      if (error instanceof Untranslatable) return { id: entry.id, ok: false, reason: error.reason };
      throw error;
    }
  });

  // pathSorts emitted only for keys actually used by an ok:true invariant,
  // in sorted-key order.
  const usedKeys = new Set<string>();
  for (const t of translated) {
    if (t.ok) collectTermKeys(t.term, usedKeys);
  }
  const pathSorts = new Map<string, IrSort>();
  for (const key of [...usedKeys].sort()) {
    const sort = sorts.get(key);
    if (sort !== undefined) pathSorts.set(key, sort);
  }

  return { translated, pathSorts, conflicts };
}

/** Smallest member key of the conflicting component, for a stable message. */
function conflictReportKey(table: SortTable, key: string): string {
  return table.rootOf(key);
}

function collectTermKeys(term: IrTerm, out: Set<string>): void {
  switch (term.kind) {
    case "pathVar":
      out.add(term.key);
      return;
    case "intLit":
    case "realLit":
    case "strLit":
    case "boolLit":
      return;
    case "and":
    case "or":
      for (const a of term.args) collectTermKeys(a, out);
      return;
    case "not":
      collectTermKeys(term.arg, out);
      return;
    case "implies":
    case "iff":
    case "eq":
    case "neq":
      collectTermKeys(term.a, out);
      collectTermKeys(term.b, out);
      return;
    case "cmp":
      collectTermKeys(term.a, out);
      collectTermKeys(term.b, out);
      return;
    case "arith":
      for (const a of term.args) collectTermKeys(a, out);
      return;
  }
}
