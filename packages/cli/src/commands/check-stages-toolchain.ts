import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { platform } from "node:os";
import {
  createViolationReport,
  type Violation,
  type ViolationReport,
} from "@stele/core";
import type { PreparedCheckContext, ProtectedCheckState } from "../architecture/types.js";
import { MAX_CHILD_PROCESS_BUFFER } from "../config/defaults.js";
import { profilePathExists } from "../design-profile/load.js";
import { loadProfile } from "../design-profile/load.js";
import { resolveCommand } from "../toolchain/command-resolver.js";
import { validateTsconfigPolicy } from "../toolchain/tsconfig-policy.js";
import { parseTscOutputToViolations, DEFAULT_TSC_COMMAND } from "../toolchain/typescript.js";
import { parseEslintReport } from "../toolchain/eslint.js";
import type { ToolchainViolation } from "../toolchain/types.js";

export async function buildToolchainStage(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  command: string,
): Promise<ViolationReport> {
  if (!profilePathExists(context.projectDir)) {
    return createEmptyViolationReport(protectedState.summary.invariantCount);
  }

  let profile: ReturnType<typeof loadProfile>;
  try {
    profile = loadProfile(context.projectDir);
  } catch (error) {
    process.stderr.write(
      "warn: failed to load design profile, skipping design checks: " + (error instanceof Error ? error.message : String(error)) + "\n",
    );
    return createEmptyViolationReport(protectedState.summary.invariantCount);
  }

  const toolchain = profile.toolchain_contracts;
  if (!toolchain) {
    return createEmptyViolationReport(protectedState.summary.invariantCount);
  }

  const violations: Violation[] = [];

  // Sub-stage 1: TypeScript config policy
  if (toolchain.typescript_config?.required_options) {
    const _tsconfigPath = toolchain.typescript_config.tsconfig_path ?? "tsconfig.json";
    try {
      const policyViolations = validateTsconfigPolicy(
        context.projectDir,
        _tsconfigPath,
        toolchain.typescript_config.required_options,
      );
      violations.push(...policyViolations.map(toolchainViolationToViolation(context.projectDir, command)));
    } catch (e) {
      // tsconfig missing or unreadable — report as violation
      const msg = e instanceof Error ? e.message : String(e);
      violations.push(toolchainViolationToViolation(context.projectDir, command)({
        ruleId: "typedriven.typescript.config.read_error",
        ruleKind: "typescript-config-policy",
        file: _tsconfigPath,
        message: `tsconfig policy check failed: ${msg}`,
        severity: "error",
        fix: "Ensure tsconfig.json exists and is valid JSON at the configured path.",
      }));
    }
  }

  // Sub-stage 2: TypeScript diagnostics
  if (toolchain.typescript_diagnostics?.enabled) {
    const tscCommand = toolchain.typescript_diagnostics.command ?? DEFAULT_TSC_COMMAND;

    // Derive the tsconfig directory from the profile so that package-relative
    // tsc output paths (e.g., "src/file.ts") can be resolved to repo-relative
    // paths (e.g., "packages/cli/src/file.ts").
    const tsconfigPath = profile.project?.tsconfig ??
      toolchain.typescript_config?.tsconfig_path ?? "tsconfig.json";
    const tsconfigDir = dirname(resolve(context.projectDir, tsconfigPath));

    try {
      const { stdout, stderr } = await runCommandFromShell(tscCommand, context.projectDir);
      const raw = stdout + stderr;
      const tscViolations = parseTscOutputToViolations(raw, context.projectDir, tsconfigDir);
      violations.push(...tscViolations.map(toolchainViolationToViolation(context.projectDir, command)));
    } catch (e) {
      // tsc command failed — report as violation, not silent skip
      const msg = e instanceof Error ? e.message : String(e);
      violations.push(toolchainViolationToViolation(context.projectDir, command)({
        ruleId: "typedriven.typescript.diagnostics.command_failed",
        ruleKind: "typescript-diagnostic",
        file: "tsconfig.json",
        message: `TypeScript diagnostics command failed: ${msg}. Command: ${tscCommand}`,
        severity: "error",
        fix: "Ensure the diagnostics command in profile.yaml is correct and the script exists in package.json.",
      }));
    }
  }

  // Sub-stage 3: ESLint
  if (toolchain.eslint?.enabled) {
    const eslintConfig = toolchain.eslint;
    const eslintCommand = eslintConfig.command ??
      `npx eslint --format ${eslintConfig.format ?? "json"} .`;
    try {
      const { stdout } = await runCommandFromShell(eslintCommand, context.projectDir);
      const report = JSON.parse(stdout);
      const eslintViolations = parseEslintReport(report, eslintConfig.rules ?? []);
      violations.push(...eslintViolations.map(toolchainViolationToViolation(context.projectDir, command)));
    } catch (e) {
      // ESLint failed — report as violation, not silent skip
      const msg = e instanceof Error ? e.message : String(e);
      violations.push(toolchainViolationToViolation(context.projectDir, command)({
        ruleId: "typedriven.eslint.command_failed",
        ruleKind: "eslint",
        file: "eslint.config.js",
        message: `ESLint command failed: ${msg}. Command: ${eslintCommand}`,
        severity: "error",
        fix: "Ensure the ESLint command in profile.yaml is correct and ESLint is installed.",
      }));
    }
  }

  return createViolationReport({
    tool: "stele",
    command,
    ok: violations.length === 0,
    summary: {
      invariant_count: protectedState.summary.invariantCount,
      violation_count: violations.length,
    },
    violations,
  });
}

function toolchainViolationToViolation(
  projectDir: string,
  command: string,
): (t: ToolchainViolation) => Violation {
  return (t) => {
    const path = t.file.includes(projectDir) ? t.file : t.file;
    return {
      rule_id: t.ruleId,
      rule_kind: t.ruleKind,
      severity: t.severity,
      source: { tool: "stele", command, kind: "rule" },
      location: { path, line: t.line, column: t.column },
      cause: { summary: t.message },
      fingerprint: t.ruleId,
      scope_paths: [path],
      status: "active" as const,
      fix: { summary: t.fix },
    };
  };
}

function runCommandFromShell(
  cmd: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // execFile is safe — no shell involved, so no injection risk.
    // resolveCommand already resolves to the absolute path (including .cmd/.bat
    // on Windows), so execFile can execute directly without shell lookup.
    const { command, args } = resolveCommand(cmd, cwd);
    // On Windows, .CMD/.BAT wrappers need shell: true for execFile to spawn
    // them. Args remain safe — execFile passes them as an array, not through
    // shell interpolation. resolveCommand resolves to absolute path first.
    const child = execFile(command, args, {
      cwd,
      maxBuffer: MAX_CHILD_PROCESS_BUFFER,
      windowsHide: true,
      shell: platform() === "win32",
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

    child.on("error", reject);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    child.on("close", (_code) => {
      // We don't fail on non-zero exit — callers (tsc, eslint) are expected
      // to return non-zero when violations exist. We capture the output and
      // parse it ourselves.
      resolve({ stdout, stderr });
    });
  });
}

function createEmptyViolationReport(invariantCount: number): ViolationReport {
  return createViolationReport({
    tool: "stele",
    command: "check",
    ok: true,
    summary: {
      invariant_count: invariantCount,
      violation_count: 0,
    },
    violations: [],
  });
}
