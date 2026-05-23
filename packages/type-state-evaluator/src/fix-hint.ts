/**
 * Default fix-hint generators for type-state violations.
 *
 * Core safety rule (Round 1 MC-15 + maintainer's explicit design): a fix-hint
 * MUST force the agent into an analysis branch BEFORE choosing an action:
 *
 *   [A] Code issue — the rule is correct, the code is wrong → fix the code.
 *   [B] Contract issue — the rule itself is wrong/outdated → investigate,
 *       document rationale, submit `stele design propose`; do NOT edit the
 *       contract directly (protected files reject agent edits anyway, but the
 *       point is to force the agent to STOP AND THINK, not to autodetect a
 *       code repair that papers over a stale rule).
 *
 * The hint is enforced by unit tests + a self-protection invariant
 * FIX_HINT_REQUIRES_ANALYSIS_BRANCH that asserts every default hint contains
 * the three keywords `code issue`, `contract issue`, and `propose`.
 */

import type { TypeStateDeclaration } from "@stele/core";

/**
 * Canonical contract-issue branch text (option B). The text reaches the agent
 * verbatim so it knows exactly which command + rationale shape is required.
 */
export function proposeExitText(declarationId: string): string {
  return [
    `[B] Contract issue — the rule itself is wrong/outdated/no-longer-applicable:`,
    `    1. Do NOT edit the contract directly — it is protected from agent modifications.`,
    `    2. Investigate: read related code, run \`git log\` on the rule's source, run \`stele why ${declarationId}\` for context.`,
    `    3. Document: write a rationale containing (a) scenarios researched, (b) evidence the rule no longer applies, (c) alternatives considered, (d) impact analysis.`,
    `    4. Submit a YAML proposal at \`contract/design/proposals/<id>.yaml\` containing the kind (\`type-state\`), the rule id (\`${declarationId}\`), and the rationale from step 3. Run \`stele design propose\` to validate it (use \`invariant\` / \`branded-id\` / \`aggregate\` as the closest existing built-in type — type-state-specific propose subcommand is a planned follow-up). Then ask the user to review the proposal.`,
    `    5. Wait for explicit user approval before any contract change.`,
  ].join("\n");
}

/**
 * Default fix-hint for `typestate.<id>.disallowed_op`. Forces A/B branching
 * before action — agent must decide whether this is a code issue or a contract
 * issue and act accordingly. Default code suggestion is only valid for [A].
 */
export function defaultDisallowedOpFixHint(
  decl: TypeStateDeclaration,
  inferredState: string,
  method: string,
  callerFile: string,
  callerLine: number,
): string {
  const location = `${callerFile}:${callerLine}`;
  const head = `Method \`${method}\` is not allowed in state \`${inferredState}\` at ${location} (rule \`${decl.id}\`).`;
  const codeBranch = [
    `[A] Code issue — the rule is correct, your code at ${location} is wrong:`,
    `    Change the receiver's state before this call via a legitimate transition declared in (type-state ${decl.id} ...),`,
    `    or re-architect the flow so \`${method}\` runs in a state where it is allowed.`,
  ].join("\n");
  return [
    head,
    ``,
    `This violation needs you to first determine: code issue or contract issue?`,
    ``,
    codeBranch,
    ``,
    proposeExitText(decl.id),
    ``,
    `Choose [A] or [B] before acting. The default code suggestion in [A] is ONLY valid if you have confirmed it is a code issue, not a contract issue.`,
  ].join("\n");
}

/**
 * Default fix-hint for `typestate.<id>.inference_failed`. Forces A/B branching:
 *   [A] Add a state annotation (phantom type, generic, sealed type, separate
 *       type) — the inference was failing because the code is missing the
 *       signal the analyzer needs.
 *   [B] If you can prove this function genuinely operates on any state of the
 *       target type (and the rule should not apply here), propose adjusting
 *       the rule.
 */
export function defaultInferenceFailedFixHint(
  decl: TypeStateDeclaration,
  callerNodeId: string,
): string {
  const head = `Type-state inference failed for caller \`${callerNodeId}\` against rule \`${decl.id}\`.`;
  const codeBranch = [
    `[A] Code issue — the rule is correct, your code lacks the state signal the analyzer needs:`,
    `    Annotate the function's receiver parameter with a phantom state (TS/Rust), a Generic state (Python), a sealed-type state (Java), or a separate state type (Go).`,
    `    Alternatively, if state can only be determined dynamically here, declare a binding in the contract:`,
    `    \`(type-state-binding (function "${callerNodeId}") (param 0 state <state>))\` — but this is a CONTRACT addition and must go through propose.`,
  ].join("\n");
  return [
    head,
    ``,
    `This violation needs you to first determine: code issue or contract issue?`,
    ``,
    codeBranch,
    ``,
    proposeExitText(decl.id),
    ``,
    `Choose [A] or [B] before acting. Adding a type-state-binding is itself a contract change — it must go through propose, never written to the contract file as a direct edit.`,
  ].join("\n");
}
