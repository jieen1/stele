// Shared path extraction utilities for Stele plugin hooks.
// All three hooks (lifecycle-context, pre-tool-protect, observation)
// share the same logic for extracting file paths from tool payloads.

export const TARGET_KEYS = ["file_path", "path", "target_path", "notebook_path"];

export function extractTargetPaths(payload) {
  return [...new Set(extractPathsFromValue(payload, new Set()))];
}

export function extractPathsFromValue(value, seen) {
  if (typeof value === "string") {
    return [];
  }

  if (!isObject(value) || seen.has(value)) {
    return [];
  }

  seen.add(value);

  const targets = [];

  for (const key of TARGET_KEYS) {
    if (typeof value[key] === "string" && value[key].trim().length > 0) {
      targets.push(value[key]);
    }
  }

  for (const nestedKey of ["tool_input", "input"]) {
    targets.push(...extractPathsFromValue(value[nestedKey], seen));
  }

  for (const nestedValue of Object.values(value)) {
    targets.push(...extractPathsFromValue(nestedValue, seen));
  }

  return targets;
}

export function isObject(value) {
  return typeof value === "object" && value !== null;
}
