import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isMissingFileError } from "../util/fs.js";
import { writeAtomic } from "../manifest/hash-manifest.js";
import { isPlainRecord } from "../util/types.js";
import type { BaselineViolation, HumanState, ViolationBaseline } from "./types.js";

export async function readViolationBaseline(path: string): Promise<ViolationBaseline> {
  return parseViolationBaseline(path, await readFile(resolve(path), "utf8"));
}

export async function tryReadViolationBaseline(path: string): Promise<ViolationBaseline | undefined> {
  try {
    return await readViolationBaseline(path);
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }
}

export async function writeViolationBaseline(path: string, baseline: ViolationBaseline): Promise<void> {
  const absolutePath = resolve(path);
  await writeAtomic(absolutePath, `${JSON.stringify(baseline, null, 2)}\n`);
}

function parseViolationBaseline(path: string, content: string): ViolationBaseline {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const safeMsg = error instanceof SyntaxError ? "malformed JSON" : "parse error";
    throw new Error(`Baseline "${path}" is not valid JSON: ${safeMsg}`);
  }

  if (!isViolationBaseline(parsed)) {
    throw new Error(`Baseline "${path}" has an invalid shape.`);
  }

  return parsed;
}

function isViolationBaseline(value: unknown): value is ViolationBaseline {
  if (!isPlainRecord(value)) {
    return false;
  }

  if (
    value.version !== "1" ||
    typeof value.generated_at !== "string" ||
    typeof value.reason !== "string" ||
    !isPlainRecord(value.violations)
  ) {
    return false;
  }

  if (value.human_state !== undefined && !isHumanState(value.human_state)) {
    return false;
  }

  return Object.entries(value.violations).every(([fingerprint, violation]) => isBaselineViolation(fingerprint, violation));
}

function isHumanState(value: unknown): value is HumanState {
  if (!isPlainRecord(value)) {
    return false;
  }

  if (!isPlainRecord(value.files) || typeof value.contract_hash !== "string") {
    return false;
  }

  return Object.entries(value.files).every(
    ([path, hash]) => typeof path === "string" && typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
  );
}

function isBaselineViolation(fingerprint: string, value: unknown): value is BaselineViolation {
  return (
    typeof fingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(fingerprint) &&
    isPlainRecord(value) &&
    typeof value.rule_id === "string" &&
    typeof value.rule_kind === "string" &&
    typeof value.first_seen === "string" &&
    isPlainRecord(value.source) &&
    typeof value.source.tool === "string" &&
    typeof value.source.command === "string" &&
    typeof value.source.kind === "string" &&
    isPlainRecord(value.location) &&
    Array.isArray(value.scope_paths) &&
    value.scope_paths.every((path) => typeof path === "string")
  );
}


