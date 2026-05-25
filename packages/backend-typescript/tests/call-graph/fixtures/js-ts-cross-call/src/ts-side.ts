import { jsHelper } from "./js-side.js";

export function tsExport(value: number): number {
  return value + 7;
}

export function tsCallsJs(value: number): number {
  return jsHelper(value);
}
