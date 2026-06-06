import type { IrSort, IrTerm } from "./translate.js";

/**
 * The Z3 driver. The ONLY module that touches z3-solver, and ONLY via a
 * dynamic `import("z3-solver")` inside `analyze` so other CLI commands never
 * pay the WASM init cost.
 *
 * Soundness rule: a Z3 `unknown` verdict is NEVER a finding. It maps to an
 * `incomplete` honesty signal (or, for MUS minimization, to `minimal:false`).
 * Determinism: fixed seed + timeout, no tactics/simplify, no model emitted,
 * variables interned and terms lowered in sorted order.
 */

export type LintInput = {
  pathSorts: ReadonlyMap<string, IrSort>;
  translatable: Array<{ id: string; term: IrTerm }>;
};

export type Finding =
  | { kind: "contradiction"; invariants: string[]; minimal: boolean }
  | { kind: "tautology"; invariant: string }
  | { kind: "subsumption"; subsumes: string; redundant: string }
  | { kind: "equivalent"; invariants: [string, string] }
  | { kind: "incomplete"; analysis: "contradiction" | "tautology" | "subsumption"; subject: string[] };

export type AnalysisResult = { findings: Finding[] };

export type AnalyzeOpts = { perCheckTimeoutMs: number };

type CheckResult = "sat" | "unsat" | "unknown";

export async function analyze(input: LintInput, opts: AnalyzeOpts): Promise<AnalysisResult> {
  const { init } = await import("z3-solver");
  const { Context } = await init();
  const Z = Context("main");

  // Types derived from the runtime `Z` value so the generic context-name
  // parameter is the literal "main" everywhere (no static z3-solver import).
  type Z3Context = typeof Z;
  type Bool = ReturnType<Z3Context["Bool"]["const"]>;
  type Arith = ReturnType<Z3Context["Int"]["const"]>;
  type AnyExpr = Arith | Bool | ReturnType<Z3Context["String"]["const"]>;
  type Solver = InstanceType<Z3Context["Solver"]>;

  const newSolver = (): Solver => {
    const s = new Z.Solver();
    // Fixed configuration for determinism. `random_seed` is the solver-level
    // seed param (`seed` is global-only and rejected here). `unsat_core`
    // enables core extraction used by the MUS minimizer.
    s.set("random_seed", 0);
    s.set("unsat_core", true);
    s.set("timeout", opts.perCheckTimeoutMs);
    return s;
  };

  // Shared variable table, built once in sorted-key order so Z3 internal IDs
  // are run-stable.
  const vars = new Map<string, AnyExpr>();
  for (const key of [...input.pathSorts.keys()].sort()) {
    const sort = input.pathSorts.get(key)!;
    const name = `p$${key}`;
    vars.set(
      key,
      sort === "Int"
        ? Z.Int.const(name)
        : sort === "Real"
          ? Z.Real.const(name)
          : sort === "Bool"
            ? Z.Bool.const(name)
            : Z.String.const(name),
    );
  }

  const lowerBool = (term: IrTerm): Bool => {
    const e = lower(term);
    return e as Bool;
  };

  const lowerArith = (term: IrTerm): Arith => lower(term) as Arith;

  const lower = (term: IrTerm): AnyExpr => {
    switch (term.kind) {
      case "pathVar": {
        const v = vars.get(term.key);
        if (v === undefined) throw new Error(`lint internal: missing var ${term.key}`);
        return v;
      }
      case "intLit":
        // The numeric domain is Real (translate.ts resolveConcrete resolves every
        // numeric path to Real for soundness). Integer-syntax literals are lowered
        // as Real so they unify with Real-sorted path variables — no Int sort is
        // ever produced for a path, so a mixed Int/Real comparison cannot arise.
        return Z.Real.val(term.value.toString());
      case "realLit":
        return Z.Real.val(term.raw);
      case "strLit":
        return Z.String.val(term.value);
      case "boolLit":
        return Z.Bool.val(term.value);
      case "and":
        return Z.And(...term.args.map(lowerBool));
      case "or":
        return Z.Or(...term.args.map(lowerBool));
      case "not":
        return Z.Not(lowerBool(term.arg));
      case "implies":
        return Z.Implies(lowerBool(term.a), lowerBool(term.b));
      case "iff":
        return Z.Iff(lowerBool(term.a), lowerBool(term.b));
      case "eq":
        return lower(term.a).eq(lower(term.b));
      case "neq":
        return lower(term.a).neq(lower(term.b));
      case "cmp": {
        const a = lowerArith(term.a);
        const b = lowerArith(term.b);
        switch (term.op) {
          case "gt":
            return a.gt(b);
          case "gte":
            return a.ge(b);
          case "lt":
            return a.lt(b);
          case "lte":
            return a.le(b);
        }
      }
      // eslint-disable-next-line no-fallthrough
      case "arith":
        return lowerArithmetic(term);
    }
  };

  const lowerArithmetic = (term: Extract<IrTerm, { kind: "arith" }>): Arith => {
    const args = term.args.map(lowerArith);
    switch (term.op) {
      case "add":
        return args.reduce((acc, x) => acc.add(x));
      case "mul":
        return args.reduce((acc, x) => acc.mul(x));
      case "sub":
        return args[0]!.sub(args[1]!);
      case "neg":
        return args[0]!.neg();
      case "abs": {
        const a = args[0]!;
        return Z.If(a.ge(0 as never), a, a.neg()) as unknown as Arith;
      }
    }
  };

  // Lower every term once, id-sorted.
  const phi: Array<{ id: string; bool: Bool }> = input.translatable
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry) => ({ id: entry.id, bool: lowerBool(entry.term) }));

  const phiById = new Map<string, Bool>();
  for (const p of phi) phiById.set(p.id, p.bool);

  const findings: Finding[] = [];

  // ---- D.1a Whole-set contradiction check -------------------------------
  const whole = newSolver();
  for (const p of phi) whole.add(p.bool);
  const wholeResult = (await whole.check()) as CheckResult;

  if (wholeResult === "unsat") {
    findings.push(await minimalUnsatCore());
    return { findings };
  }

  if (wholeResult === "unknown") {
    findings.push({ kind: "incomplete", analysis: "contradiction", subject: [] });
    // tautology remains sound (per-invariant validity); redundancy needs sat.
    await runTautology(phi, Z, newSolver, findings);
    return { findings };
  }

  // wholeResult === "sat": run tautology + pairwise redundancy.
  await runTautology(phi, Z, newSolver, findings);
  await runRedundancy(phi, Z, newSolver, findings);
  return { findings };

  // ---- helpers ----------------------------------------------------------

  async function runTautology(
    terms: Array<{ id: string; bool: Bool }>,
    Zc: Z3Context,
    mk: typeof newSolver,
    out: Finding[],
  ): Promise<void> {
    for (const { id, bool } of terms) {
      const s = mk();
      s.add(Zc.Not(bool));
      const r = (await s.check()) as CheckResult;
      if (r === "unsat") out.push({ kind: "tautology", invariant: id });
      else if (r === "unknown") out.push({ kind: "incomplete", analysis: "tautology", subject: [id] });
    }
  }

  async function runRedundancy(
    terms: Array<{ id: string; bool: Bool }>,
    Zc: Z3Context,
    mk: typeof newSolver,
    out: Finding[],
  ): Promise<void> {
    const implies = async (A: Bool, B: Bool): Promise<"yes" | "no" | "unknown"> => {
      const s = mk();
      s.add(A);
      s.add(Zc.Not(B));
      const r = (await s.check()) as CheckResult;
      return r === "unsat" ? "yes" : r === "sat" ? "no" : "unknown";
    };

    for (let i = 0; i < terms.length; i += 1) {
      for (let j = i + 1; j < terms.length; j += 1) {
        const A = terms[i]!;
        const B = terms[j]!; // idA < idB by construction (sorted)
        const ab = await implies(A.bool, B.bool);
        const ba = await implies(B.bool, A.bool);
        if (ab === "unknown" || ba === "unknown") {
          out.push({ kind: "incomplete", analysis: "subsumption", subject: [A.id, B.id] });
          continue;
        }
        if (ab === "yes" && ba === "yes") {
          out.push({ kind: "equivalent", invariants: [A.id, B.id] });
        } else if (ab === "yes" && ba === "no") {
          out.push({ kind: "subsumption", subsumes: A.id, redundant: B.id });
        } else if (ab === "no" && ba === "yes") {
          out.push({ kind: "subsumption", subsumes: B.id, redundant: A.id });
        }
      }
    }
  }

  async function minimalUnsatCore(): Promise<Finding> {
    // assumptions + deletion-based minimization -> guaranteed MUS (linear).
    const s = newSolver();
    const sel = new Map<string, Bool>();
    const nameToId = new Map<string, string>();
    for (const { id, bool } of phi) {
      const p = Z.Bool.const(`__sel$${id}`);
      sel.set(id, p);
      nameToId.set(p.toString(), id);
      s.add(p.implies(bool));
    }
    await s.check(...[...sel.values()]);

    let core: string[] = [];
    const coreVec = s.unsatCore();
    for (let i = 0; i < coreVec.length(); i += 1) {
      const id = nameToId.get(coreVec.get(i).toString());
      if (id !== undefined) core.push(id);
    }
    if (core.length === 0) core = phi.map((p) => p.id); // defensive: full set
    core.sort();

    let mus = [...core];
    let minimal = true;
    for (const cand of [...core].sort()) {
      const trial = mus.filter((id) => id !== cand);
      if (trial.length === 0) break;
      const t = newSolver();
      for (const id of trial) t.add(phiById.get(id)!);
      const rr = (await t.check()) as CheckResult;
      if (rr === "unsat") mus = trial;
      else if (rr === "unknown") minimal = false;
    }

    return { kind: "contradiction", invariants: mus.sort(), minimal };
  }
}
