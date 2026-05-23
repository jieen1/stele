import { getJson } from "../../http.js";
import { nowMs } from "../../clock.js";

/**
 * VIOLATION #2 — PURE_LIB_ONLY catches http.outgoing here.
 */
export function formatRemote(url: string): string {
  const r = getJson(url);
  return `${nowMs()}:${r.url}`;
}
