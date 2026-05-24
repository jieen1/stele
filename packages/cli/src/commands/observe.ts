import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stableStringCompare } from "@stele/core";

/**
 * stele observe — analyze agent observation data for invariant health trends.
 *
 * Reads .stele/agent/session-observations.jsonl files and aggregates:
 * - Which protected files were touched most often ("nearly violated" invariants)
 * - Which tools target protected files most aggressively
 * - Session-level activity summary
 *
 * Data source: observation-hook.js writes one JSON line per tool use.
 */

// --- Types ---

interface ObservationEntry {
  timestamp: string;
  session_id: string | null;
  hook_event_name: string;
  tool_name: string | null;
  target_paths: string[];
  material_change: boolean;
}

export interface ObserveOptions {
  json?: boolean;
  format?: "text" | "json" | "html";
  since?: string; // ISO date string
  limit?: number;
}

interface ToolStats {
  tool_name: string;
  total_invocations: number;
  protected_hits: number;
  material_changes: number;
}

interface PathStats {
  path: string;
  touch_count: number;
  material_changes: number;
  sessions: string[];
}

interface SessionStats {
  session_id: string;
  start_time: string;
  end_time: string;
  total_tools: number;
  protected_hits: number;
  material_changes: number;
}

interface ObserveSummary {
  total_observations: number;
  total_sessions: number;
  total_material_changes: number;
  time_range: {
    earliest: string;
    latest: string;
  };
  top_paths: PathStats[];
  top_tools: ToolStats[];
  sessions: SessionStats[];
}

// --- Core functions ---

const DEFAULT_OBSERVATIONS_PATH = ".stele/agent/session-observations.jsonl";

export async function runObserve(projectDir: string, options: ObserveOptions = {}): Promise<void> {
  const observationsPath = join(projectDir, DEFAULT_OBSERVATIONS_PATH);

  if (!existsSync(observationsPath)) {
    const fallback = resolve(projectDir, DEFAULT_OBSERVATIONS_PATH);
    process.stderr.write(
      `[stele] No observation data found at ${fallback}.\n` +
      `Observation data is collected by the Stele Claude Code plugin (observation-hook.js).\n` +
      `Install the plugin to start collecting agent activity data.\n`
    );
    process.exitCode = 1;
    return;
  }

  const entries = await readObservations(observationsPath);

  if (entries.length === 0) {
    process.stdout.write(`[stele] Observation file exists but contains no entries.\n`);
    return;
  }

  // Filter by --since
  let filtered = entries;
  if (options.since) {
    filtered = entries.filter((e) => e.timestamp >= options.since!);
  }

  if (filtered.length === 0) {
    process.stdout.write(`[stele] No observations since ${options.since}.\n`);
    return;
  }

  const summary = aggregateObservations(filtered);

  if (options.json || options.format === "json") {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  process.stdout.write(formatSummaryText(summary));

  // Apply --limit for text output
  if (options.limit) {
    // Already applied in formatSummaryText
  }
}

async function readObservations(path: string): Promise<ObservationEntry[]> {
  const raw = await readFile(path, "utf8");
  const lines = raw.trim().split("\n").filter((line) => line.trim().length > 0);
  const entries: ObservationEntry[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as ObservationEntry;
      if (entry && typeof entry.timestamp === "string") {
        entries.push(entry);
      }
    } catch {
      // Skip malformed lines silently
    }
  }

  // Sort by timestamp
  entries.sort((a, b) => stableStringCompare(a.timestamp, b.timestamp));

  return entries;
}

function aggregateObservations(entries: ObservationEntry[]): ObserveSummary {
  // Collect unique sessions
  const sessionMap = new Map<string, ObservationEntry[]>();
  const pathMap = new Map<string, PathStats>();
  const toolMap = new Map<string, ToolStats>();
  let totalMaterialChanges = 0;

  for (const entry of entries) {
    // Session aggregation
    const sid = entry.session_id ?? "unknown";
    const sessionEntries = sessionMap.get(sid) ?? [];
    sessionEntries.push(entry);
    sessionMap.set(sid, sessionEntries);

    // Path aggregation
    for (const tp of entry.target_paths) {
      const existing = pathMap.get(tp);
      if (existing) {
        existing.touch_count += 1;
        if (entry.material_change) existing.material_changes += 1;
        if (!existing.sessions.includes(sid)) existing.sessions.push(sid);
      } else {
        pathMap.set(tp, {
          path: tp,
          touch_count: 1,
          material_changes: entry.material_change ? 1 : 0,
          sessions: entry.material_change ? [sid] : [],
        });
      }
    }

    // Tool aggregation
    const toolName = entry.tool_name ?? "unknown";
    const toolExisting = toolMap.get(toolName);
    if (toolExisting) {
      toolExisting.total_invocations += 1;
      if (entry.target_paths.length > 0) toolExisting.protected_hits += 1;
      if (entry.material_change) toolExisting.material_changes += 1;
    } else {
      toolMap.set(toolName, {
        tool_name: toolName,
        total_invocations: 1,
        protected_hits: entry.target_paths.length > 0 ? 1 : 0,
        material_changes: entry.material_change ? 1 : 0,
      });
    }

    if (entry.material_change) totalMaterialChanges += 1;
  }

  // Sort paths by touch_count desc
  const topPaths = [...pathMap.values()].sort((a, b) => b.touch_count - a.touch_count);

  // Sort tools by material_changes desc
  const topTools = [...toolMap.values()].sort((a, b) => b.material_changes - a.material_changes);

  // Build session stats
  const sessions: SessionStats[] = [];
  for (const [sid, sEntries] of sessionMap) {
    const protectedHits = sEntries.filter((e) => e.target_paths.length > 0).length;
    const materialChanges = sEntries.filter((e) => e.material_change).length;
    sessions.push({
      session_id: sid,
      start_time: sEntries[0]?.timestamp ?? "",
      end_time: sEntries[sEntries.length - 1]?.timestamp ?? "",
      total_tools: sEntries.length,
      protected_hits: protectedHits,
      material_changes: materialChanges,
    });
  }
  sessions.sort((a, b) => b.material_changes - a.material_changes);

  return {
    total_observations: entries.length,
    total_sessions: sessionMap.size,
    total_material_changes: totalMaterialChanges,
    time_range: {
      earliest: entries[0]?.timestamp ?? "",
      latest: entries[entries.length - 1]?.timestamp ?? "",
    },
    top_paths: topPaths,
    top_tools: topTools,
    sessions,
  };
}

function formatSummaryText(summary: ObserveSummary): string {
  const lines: string[] = [];

  lines.push("[stele] Agent Activity Observation Summary");
  lines.push("");
  lines.push(`  Total observations:   ${summary.total_observations}`);
  lines.push(`  Unique sessions:      ${summary.total_sessions}`);
  lines.push(`  Material changes:     ${summary.total_material_changes}`);
  lines.push(`  Time range:           ${summary.time_range.earliest} → ${summary.time_range.latest}`);
  lines.push("");

  // Top touched paths (the "nearly violated" signals)
  lines.push("--- Most Touched Protected Paths ---");
  const pathLimit = 10;
  for (const p of summary.top_paths.slice(0, pathLimit)) {
    const danger = p.material_changes > 0 ? " [MATERIAL]" : "";
    lines.push(`  ${p.touch_count}x  ${p.path}${danger}`);
  }
  if (summary.top_paths.length === 0) {
    lines.push("  (none)");
  }
  lines.push("");

  // Tool breakdown
  lines.push("--- Tool Activity (sorted by material changes) ---");
  const toolLimit = 10;
  for (const t of summary.top_tools.slice(0, toolLimit)) {
    lines.push(
      `  ${t.tool_name}: ${t.total_invocations} invocations, ` +
      `${t.protected_hits} protected hits, ${t.material_changes} material`
    );
  }
  if (summary.top_tools.length === 0) {
    lines.push("  (none)");
  }
  lines.push("");

  // Sessions with material changes
  const riskySessions = summary.sessions.filter((s) => s.material_changes > 0);
  if (riskySessions.length > 0) {
    lines.push("--- Sessions with Material Changes ---");
    for (const s of riskySessions.slice(0, 5)) {
      const sid = s.session_id.length > 12 ? s.session_id.slice(0, 12) + "..." : s.session_id;
      lines.push(`  ${sid}: ${s.material_changes} material changes in ${s.total_tools} tool uses`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
