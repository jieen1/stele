import { tsExport } from "./ts-side.js";

export function jsHelper(value) {
  return value + 1;
}

export function jsCallsTs(value) {
  return tsExport(value);
}
