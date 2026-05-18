import { readdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join as pathJoin } from "node:path";
import { join, resolve } from "node:path";
import {
  ComplexityMeasureOutput,
  ComplexitySuggestOutput,
  getMetricStatus,
  parseCoreNodeTarget,
  type CoreNodeMeasurement,
  type SuggestCandidate,
} from "../complexity/types.js";
import { evaluateCoreNodes, evaluateCoreNode } from "../complexity/evaluate.js";
import { loadConfig } from "../config/loadConfig.js";
import { loadContract } from "@stele/core";

// ----------------------------------------------------------------
// Options
// ----------------------------------------------------------------

export interface ComplexityOptions {
  lang?: string;
  output?: string;
  json?: boolean;
}

// ----------------------------------------------------------------
// `stele complexity suggest`
// ----------------------------------------------------------------

/**
 * Scan the project for classes that are good candidates for core-node contracts.
 *
 * Criteria:
 * - Classes with >50 SLOC
 * - Classes with >5 public methods
 * - Classes imported by >3 other files (high fan-in)
 *
 * Output as JSON (with --json) or as a table (default).
 */
export async function runComplexitySuggest(projectDir: string, options: ComplexityOptions = {}): Promise<void> {
  const resolved = resolve(projectDir);
  const config = await loadConfig(resolved);

  const candidates = await discoverCandidates(resolved, config);

  const output: ComplexitySuggestOutput = {
    schema_version: "1",
    generated_at: new Date().toISOString(),
    language: "typescript",
    candidates,
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  } else {
    if (candidates.length === 0) {
      process.stdout.write("No candidates found.\n");
      return;
    }
    process.stdout.write(formatSuggestTable(candidates));
  }

  if (options.output) {
    const { writeFile } = await import("node:fs/promises");
    const { mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const outputPath = resolve(resolved, options.output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n", "utf8");
  }
}

async function discoverCandidates(projectDir: string, _config: { targetLanguage?: string }): Promise<SuggestCandidate[]> {
  const sourceFiles: string[] = [];
  await walkTypeScriptFiles(projectDir, sourceFiles);

  if (sourceFiles.length === 0) {
    return [];
  }

  // Build fan-in map: count how many files import each file
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  const { readFileSync } = await import("node:fs");
  // readFileSync is available from the static import above; keep this line for other APIs

  for (const file of sourceFiles) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    // Extract imports
    const importSpecifiers = extractImportSpecifiers(text);
    fanOut.set(file, importSpecifiers.length);

    for (const specifier of importSpecifiers) {
      // Try to resolve specifier to a source file
      const resolved = tryResolveSpecifier(projectDir, file, specifier);
      if (resolved) {
        fanIn.set(resolved, (fanIn.get(resolved) ?? 0) + 1);
      }
    }
  }

  const candidates: SuggestCandidate[] = [];

  for (const file of sourceFiles) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const classes = extractClassInfo(text, file);

    for (const cls of classes) {
      const fanInCount = fanIn.get(file) ?? 0;
      const fanOutCount = fanOut.get(file) ?? 0;

      // Filter: must meet at least one criterion
      const meetsSloc = cls.sloc > 50;
      const meetsMethods = cls.publicMethodCount > 5;
      const meetsFanIn = fanInCount > 3;

      if (!meetsSloc && !meetsMethods && !meetsFanIn) {
        continue;
      }

      const reasons: string[] = [];
      if (meetsSloc) {
        reasons.push(`${cls.sloc} SLOC`);
      }
      if (meetsMethods) {
        reasons.push(`${cls.publicMethodCount} public methods`);
      }
      if (meetsFanIn) {
        reasons.push(`${fanInCount} fan-in`);
      }

      const relFile = file.startsWith(projectDir) ? file.slice(projectDir.length + 1) : file;
      candidates.push({
        target: `${relFile}::${cls.name}`,
        suggestedRole: "business-core-service",
        signals: {
          sloc: cls.sloc,
          publicMethodCount: cls.publicMethodCount,
          fanIn: fanInCount,
          fanOut: fanOutCount,
        },
        reason: reasons.join("; ") || "meets at least one criterion",
      });
    }
  }

  // Sort by total signal score (descending)
  candidates.sort((a, b) => {
    const scoreA = a.signals.sloc + a.signals.publicMethodCount * 10 + a.signals.fanIn * 5;
    const scoreB = b.signals.sloc + b.signals.publicMethodCount * 10 + b.signals.fanIn * 5;
    return scoreB - scoreA;
  });

  return candidates;
}

/**
 * Extract import specifiers from TypeScript source text.
 */
function extractImportSpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  const importRegex = /(?:import|require)\s*\([^)]*\)\s*from\s+["']([^"']+)["']|import\s*\{[^}]*\}\s*from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(text)) !== null) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

/**
 * Attempt to resolve a module specifier to an absolute file path.
 */
function tryResolveSpecifier(projectDir: string, fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const dir = dirname(fromFile);
  const resolved = pathJoin(dir, specifier);
  if (existsSync(resolved)) return resolved;
  for (const ext of [".ts", ".tsx", ".js"]) {
    const candidate = resolved + ext;
    if (existsSync(candidate)) return candidate;
  }
  const indexTs = pathJoin(resolved, "index.ts");
  if (existsSync(indexTs)) return indexTs;
  return undefined;
}

/**
 * Extract class declarations from TypeScript source text.
 */
function extractClassInfo(text: string, filePath: string): Array<{ name: string; sloc: number; publicMethodCount: number }> {
  const classes: Array<{ name: string; sloc: number; publicMethodCount: number }> = [];
  const lines = text.split("\n");

  // Simple regex-based extraction for classes
  const classRegex = /class\s+(\w+)(?:\s+extends\s+\w+)?\s*\{/g;
  let classMatch: RegExpExecArray | null;

  while ((classMatch = classRegex.exec(text)) !== null) {
    const className = classMatch[1];
    const classStart = classMatch.index;

    // Find the line number where the class starts
    const textBeforeClass = text.slice(0, classStart);
    const startLine = textBeforeClass.split("\n").length;

    // Count lines until the next class or end of file
    let sloc = 0;
    let braceDepth = 0;
    let methodCount = 0;
    let inClass = false;

    for (let i = startLine - 1; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Count braces to track class scope
      for (const char of line) {
        if (char === "{") {
          braceDepth++;
          inClass = true;
        } else if (char === "}") {
          braceDepth--;
          if (inClass && braceDepth === 0) {
            // End of class
            break;
          }
        }
      }

      if (!inClass) continue;

      // Count SLOC (non-blank, non-comment)
      if (trimmed.length > 0 && !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*")) {
        sloc++;
      }

      // Count public methods (basic heuristic)
      if (/^\s*(public|protected|private)?\s*(?:async\s+)?\w+\s*\(/.test(line) &&
          !line.includes("constructor") &&
          !line.includes("=>") &&
          !line.includes("import") &&
          !line.includes("export")) {
        methodCount++;
      }

      if (inClass && braceDepth === 0) {
        break;
      }
    }

    classes.push({
      name: className,
      sloc,
      publicMethodCount: methodCount,
    });
  }

  return classes;
}

function formatSuggestTable(candidates: SuggestCandidate[]): string {
  const lines: string[] = [];
  // Header
  const header = `${"target".padEnd(50)} ${"sloc".padEnd(7)} ${"methods".padEnd(9)} ${"fan-in".padEnd(7)}\n`;
  lines.push(header);
  lines.push("─".repeat(75) + "\n");

  for (const candidate of candidates) {
    const target = candidate.target.length > 49 ? candidate.target.slice(0, 46) + "…" : candidate.target.padEnd(50);
    const sloc = String(candidate.signals.sloc).padEnd(7);
    const methods = String(candidate.signals.publicMethodCount).padEnd(9);
    const fanIn = String(candidate.signals.fanIn).padEnd(7);
    lines.push(`${target} ${sloc} ${methods} ${fanIn}\n`);
  }

  return lines.join("");
}

// ----------------------------------------------------------------
// `stele complexity measure --json`
// ----------------------------------------------------------------

/**
 * For all declared core nodes in the contract, measure current metrics and output JSON.
 */
export async function runComplexityMeasure(projectDir: string, options: ComplexityOptions = {}): Promise<void> {
  const resolved = resolve(projectDir);
  const config = await loadConfig(resolved);

  let contract;
  try {
    contract = await loadContract(resolve(resolved, config.entry));
  } catch {
    if (options.json) {
      process.stdout.write(JSON.stringify({ core_nodes: [] }, null, 2) + "\n");
      return;
    }
    process.stdout.write("No contract found. Run 'stele init' first.\n");
    return;
  }

  const coreNodes = contract.coreNodes;

  if (coreNodes.length === 0) {
    if (options.json) {
      process.stdout.write(JSON.stringify({ core_nodes: [] }, null, 2) + "\n");
      return;
    }
    process.stdout.write("No core-node declarations found in the contract.\n");
    return;
  }

  const results = await evaluateCoreNodes(resolved, coreNodes);

  const output: ComplexityMeasureOutput = {
    core_nodes: results.map((result) => result.measurement),
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  } else {
    formatMeasureHuman(output);
  }
}

function formatMeasureHuman(output: ComplexityMeasureOutput): void {
  if (output.core_nodes.length === 0) {
    process.stdout.write("No core-node declarations found.\n");
    return;
  }

  for (const node of output.core_nodes) {
    process.stdout.write(`\n${node.id} (${node.target}):\n`);
    for (const metric of node.metrics) {
      const statusLabel = metric.status === "ok" ? "ok" : metric.status === "above-ideal" ? "above-ideal" : "OVER-MAX";
      process.stdout.write(
        `  ${metric.name.padEnd(22)} ${String(metric.value).padStart(5)} / ideal:${metric.ideal}  max:${metric.max}  [${statusLabel}]\n`,
      );
    }
  }
  process.stdout.write("\n");
}

// ----------------------------------------------------------------
// TypeScript file walker (replaces glob dependency)
// ----------------------------------------------------------------

async function walkTypeScriptFiles(dir: string, results: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    // Skip node_modules, dist, and hidden directories
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      await walkTypeScriptFiles(fullPath, results);
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      // Skip declaration files
      if (!entry.name.endsWith(".d.ts")) {
        results.push(fullPath);
      }
    }
  }
}

