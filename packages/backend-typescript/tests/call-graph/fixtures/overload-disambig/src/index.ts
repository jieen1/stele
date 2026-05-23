// Two top-level functions with same name and arity but different param types.
// They share file + (empty) container + name + arity → must get disambiguators.
// (Real TS would error on redeclaration, so we wrap in modules.)
export namespace ModA {
  export function find(s: string): string {
    return s;
  }
}

export namespace ModB {
  export function find(n: number): number {
    return n;
  }
}
