/**
 * NodeId parsing, formatting, and disambiguator helpers.
 *
 * Format:
 *   {filePath}::{container::*}::{symbol}({arity})[#{disambiguator}]
 *
 * Extern form:
 *   extern:{logical-name}::{container::*}::{symbol}({arity})[#{disambiguator}]
 *
 * Examples:
 *   src/order.ts::Order::pay(1)
 *   src/order.ts::Order::pay(1)#a3f5b7c2
 *   src/util.ts::formatDate(1)
 *   src/handler.ts::lambda@42:7(0)
 *   extern:stripe::Charges::create(2)
 *   src/a.ts::OuterClass::InnerClass::method(2)
 */

import { createHash } from "node:crypto";

export interface ParsedNodeId {
  /** Undefined when extern. */
  readonly filePath: string | undefined;
  readonly isExtern: boolean;
  /** e.g. "stripe". Undefined when not extern. */
  readonly externLogicalName: string | undefined;
  /** ["Order"] for a method, [] for a free function. */
  readonly container: readonly string[];
  /** "pay" / "lambda@N:M". */
  readonly symbolName: string;
  readonly arity: number;
  /** 8-char SHA-1 prefix. Undefined when not present. */
  readonly disambiguator: string | undefined;
}

const EXTERN_PREFIX = "extern:";

/**
 * The trailing `(arity)[#disambig]` segment regex. We anchor it to the
 * end of the string so an accidental `(` earlier in a symbol (e.g. a
 * lambda token) does not confuse parsing.
 *
 * arity must be a non-negative integer; disambiguator must be exactly 8
 * lowercase hex characters.
 */
const TAIL_REGEX = /^(.+?)\((\d+)\)(?:#([0-9a-f]{8}))?$/;

/**
 * Parse a NodeId string back into structured form. Returns null on
 * malformed input — callers should treat null as "not a valid NodeId"
 * and not throw.
 */
export function parseNodeId(text: string): ParsedNodeId | null {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }

  let isExtern = false;
  let externLogicalName: string | undefined;
  let filePath: string | undefined;
  let rest: string;

  if (text.startsWith(EXTERN_PREFIX)) {
    isExtern = true;
    const afterPrefix = text.slice(EXTERN_PREFIX.length);
    const sepIndex = afterPrefix.indexOf("::");
    if (sepIndex <= 0) {
      return null;
    }
    externLogicalName = afterPrefix.slice(0, sepIndex);
    if (!isValidExternLogicalName(externLogicalName)) {
      return null;
    }
    rest = afterPrefix.slice(sepIndex + 2);
  } else {
    const firstSep = text.indexOf("::");
    if (firstSep <= 0) {
      return null;
    }
    filePath = text.slice(0, firstSep);
    rest = text.slice(firstSep + 2);
  }

  if (rest.length === 0) {
    return null;
  }

  // The tail of `rest` is `symbol(arity)[#disambig]`. Everything before
  // that (joined by `::`) is the container chain. We locate the last
  // `::` that precedes the final `(...)` group.
  const tailMatch = TAIL_REGEX.exec(rest);
  if (!tailMatch) {
    return null;
  }
  const head = tailMatch[1];
  const arityStr = tailMatch[2];
  const disambiguator = tailMatch[3];

  if (head === undefined || arityStr === undefined) {
    return null;
  }

  const arity = Number(arityStr);
  if (!Number.isFinite(arity) || arity < 0 || !Number.isInteger(arity)) {
    return null;
  }

  // Split head into container chain + symbol.
  const headParts = head.split("::");
  const symbolName = headParts.pop();
  if (symbolName === undefined || symbolName.length === 0) {
    return null;
  }
  // Empty entries in the container chain mean stray `::`.
  if (headParts.some((p) => p.length === 0)) {
    return null;
  }

  return {
    filePath,
    isExtern,
    externLogicalName,
    container: Object.freeze(headParts),
    symbolName,
    arity,
    disambiguator,
  };
}

/**
 * Build a NodeId string from parts. Disambiguator is optional. Exactly
 * one of `filePath` / `externLogicalName` must be provided.
 */
export function formatNodeId(parts: {
  filePath?: string;
  externLogicalName?: string;
  container?: readonly string[];
  symbolName: string;
  arity: number;
  disambiguator?: string;
}): string {
  const {
    filePath,
    externLogicalName,
    container = [],
    symbolName,
    arity,
    disambiguator,
  } = parts;

  if (filePath !== undefined && externLogicalName !== undefined) {
    throw new Error(
      "formatNodeId: pass either filePath or externLogicalName, not both",
    );
  }
  if (filePath === undefined && externLogicalName === undefined) {
    throw new Error(
      "formatNodeId: must provide one of filePath or externLogicalName",
    );
  }
  if (typeof symbolName !== "string" || symbolName.length === 0) {
    throw new Error("formatNodeId: symbolName required");
  }
  if (!Number.isInteger(arity) || arity < 0) {
    throw new Error("formatNodeId: arity must be a non-negative integer");
  }
  if (disambiguator !== undefined && !/^[0-9a-f]{8}$/.test(disambiguator)) {
    throw new Error(
      "formatNodeId: disambiguator must be exactly 8 lowercase hex chars",
    );
  }

  const prefix =
    externLogicalName !== undefined
      ? `${EXTERN_PREFIX}${externLogicalName}`
      : (filePath as string);

  const containerSegment = container.length > 0 ? `${container.join("::")}::` : "";
  const suffix = disambiguator !== undefined ? `#${disambiguator}` : "";
  return `${prefix}::${containerSegment}${symbolName}(${arity})${suffix}`;
}

/**
 * Compute a deterministic 8-hex-char disambiguator from a parameter
 * type signature.
 *
 * Whitespace normalization rule: every run of ASCII whitespace
 * (space, tab, newline, carriage return) collapses to a single space,
 * and leading/trailing whitespace is stripped before hashing. This
 * ensures `"BigDecimal, String"` and `"BigDecimal,  String"` collide,
 * matching the spec's "normalized parameter type string" requirement.
 */
export function computeDisambiguator(parameterTypeSignature: string): string {
  const normalized = parameterTypeSignature
    .replace(/[\s\t\r\n]+/g, " ")
    .trim();
  return createHash("sha1").update(normalized, "utf8").digest("hex").slice(0, 8);
}

function isValidExternLogicalName(name: string): boolean {
  // logical-name: lowercase + kebab-case, must start with a letter
  return /^[a-z][a-z0-9-]*$/.test(name);
}
