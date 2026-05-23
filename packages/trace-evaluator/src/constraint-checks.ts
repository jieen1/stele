/**
 * Per-constraint check functions. Each is a thin predicate returning either a
 * boolean violation flag or the matched offender (for cause reporting). These
 * are intentionally pure — composing them into Violation records is the job of
 * `violation-builder.ts`.
 */

import type { CompiledPattern } from "@stele/call-graph-core";

import type { EnumeratedPath, OutgoingCall } from "./path-enumeration.js";

function anyPatternMatches(
  nodeId: string,
  patterns: readonly CompiledPattern[],
): boolean {
  for (const p of patterns) {
    if (p.matches(nodeId)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true when the path FAILS the must-transit constraint, i.e. no node
 * along the path (excluding caller and target) matches any of the transit
 * patterns. We consider intermediate nodes only — caller and target themselves
 * are not considered "transit" steps.
 */
export function checkMustTransit(
  path: EnumeratedPath,
  mustTransitPatterns: readonly CompiledPattern[],
): boolean {
  if (mustTransitPatterns.length === 0) {
    return false;
  }
  if (path.nodes.length <= 2) {
    // No intermediates at all — direct call. The must-transit constraint
    // is violated unless the caller itself happens to match (which is
    // weird semantically; we still treat direct calls as missing-transit).
    return true;
  }
  for (let i = 1; i < path.nodes.length - 1; i += 1) {
    const node = path.nodes[i];
    if (node === undefined) {
      continue;
    }
    if (anyPatternMatches(node, mustTransitPatterns)) {
      return false;
    }
  }
  return true;
}

/**
 * Returns true when the path is a direct edge AND the caller matches any
 * deny-direct pattern.
 */
export function checkDenyDirect(
  path: EnumeratedPath,
  callerId: string,
  denyDirectPatterns: readonly CompiledPattern[],
): boolean {
  if (denyDirectPatterns.length === 0) {
    return false;
  }
  if (path.nodes.length !== 2) {
    return false;
  }
  return anyPatternMatches(callerId, denyDirectPatterns);
}

/**
 * Returns the FIRST intermediate node in `path[1:-1]` matching any
 * deny-transit pattern, else null.
 */
export function checkDenyTransit(
  path: EnumeratedPath,
  denyTransitPatterns: readonly CompiledPattern[],
): string | null {
  if (denyTransitPatterns.length === 0) {
    return null;
  }
  for (let i = 1; i < path.nodes.length - 1; i += 1) {
    const node = path.nodes[i];
    if (node === undefined) {
      continue;
    }
    if (anyPatternMatches(node, denyTransitPatterns)) {
      return node;
    }
  }
  return null;
}

/**
 * Compare two call sites: returns -1 if (lineA, colA) < (lineB, colB), 0 if
 * equal, 1 if greater. Used for must-be-preceded-by / must-be-followed-by.
 */
function compareSite(
  lineA: number,
  colA: number,
  lineB: number,
  colB: number,
): number {
  if (lineA !== lineB) {
    return lineA < lineB ? -1 : 1;
  }
  if (colA !== colB) {
    return colA < colB ? -1 : 1;
  }
  return 0;
}

/**
 * Returns true when no edge in `callerBodyEdges` whose `toId` matches a
 * predecessor pattern appears BEFORE (line, column) of the target call.
 */
export function checkMustBePrecededBy(
  callerBodyEdges: readonly OutgoingCall[],
  targetCallLine: number,
  targetCallColumn: number,
  precededByPatterns: readonly CompiledPattern[],
): boolean {
  if (precededByPatterns.length === 0) {
    return false;
  }
  for (const edge of callerBodyEdges) {
    if (
      compareSite(edge.line, edge.column, targetCallLine, targetCallColumn) >= 0
    ) {
      continue;
    }
    if (anyPatternMatches(edge.toId, precededByPatterns)) {
      return false;
    }
  }
  return true;
}

/**
 * Mirror of `checkMustBePrecededBy`: returns true when no edge matching the
 * follow-up pattern appears AFTER the target call.
 */
export function checkMustBeFollowedBy(
  callerBodyEdges: readonly OutgoingCall[],
  targetCallLine: number,
  targetCallColumn: number,
  followedByPatterns: readonly CompiledPattern[],
): boolean {
  if (followedByPatterns.length === 0) {
    return false;
  }
  for (const edge of callerBodyEdges) {
    if (
      compareSite(edge.line, edge.column, targetCallLine, targetCallColumn) <= 0
    ) {
      continue;
    }
    if (anyPatternMatches(edge.toId, followedByPatterns)) {
      return false;
    }
  }
  return true;
}
