import { chunk, uniq } from "lodash";

export function caller(): number[][] {
  return chunk([1, 2, 3, 4], 2);
}

export function caller2(): number[] {
  return uniq([1, 1, 2]);
}
