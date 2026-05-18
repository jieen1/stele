import { alphaFn } from "../a/mod.js";

export function betaFn(): string {
  return "beta-" + alphaFn();
}
