import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isMissingFileError } from "../util/fs.js";
import { isPlainRecord } from "../util/types.js";
import type { BaselineViolation, ViolationBaseline } from "./types.js";

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
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

function parseViolationBaseline(path: string, content: string): ViolationBaseline {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Baseline "${path}" is not valid JSON: ${message}`);
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

  return Object.entries(value.violations).every(([fingerprint, violation]) => isBaselineViolation(fingerprint, violation));
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


