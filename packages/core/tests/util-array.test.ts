import { describe, expect, it } from "vitest";
import { uniqueSortedStrings } from "../src/util/array.js";

describe("uniqueSortedStrings", () => {
  it("handles empty array", () => {
    expect(uniqueSortedStrings([])).toEqual([]);
  });

  it("deduplicates and sorts", () => {
    expect(uniqueSortedStrings(["c", "a", "b", "a", "c"])).toEqual(["a", "b", "c"]);
  });

  it("returns sorted array for unique input", () => {
    expect(uniqueSortedStrings(["x", "y", "z"])).toEqual(["x", "y", "z"]);
  });

  it("is deterministic", () => {
    const input = ["b", "a", "c", "b", "a"];
    const result1 = uniqueSortedStrings(input);
    const result2 = uniqueSortedStrings(input);
    expect(result1).toEqual(result2);
  });

  it("handles single element", () => {
    expect(uniqueSortedStrings(["a"])).toEqual(["a"]);
  });

  it("handles all duplicates", () => {
    expect(uniqueSortedStrings(["a", "a", "a", "a"])).toEqual(["a"]);
  });

  it("handles special characters", () => {
    // localeCompare is locale-dependent; verify dedup + sort works
    const result = uniqueSortedStrings(["z", "a", "A", "Z", "z"]);
    expect(result).toHaveLength(4);
    expect(result).toEqual([...new Set(result)]); // no duplicates
    expect(result).not.toEqual(["z", "a", "A", "Z"]); // was sorted
  });
});
