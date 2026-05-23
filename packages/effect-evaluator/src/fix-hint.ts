/**
 * Default fix-hint generators for effect violations.
 *
 * Core safety rule (Round 2 MC-15 + Round 1 trace-policy precedent): every
 * default fix-hint MUST force the agent into an analysis branch BEFORE
 * choosing an action.
 *
 *   [A] Code issue — the policy is correct, the code is wrong → fix code.
 *   [B] Contract issue — the policy itself is wrong/outdated → investigate,
 *       document rationale, submit `stele design propose --effect-policy`;
 *       do NOT edit the contract directly.
 *
 * The hint is enforced by unit tests + a self-protection invariant
 * FIX_HINT_REQUIRES_ANALYSIS_BRANCH that asserts every default hint contains
 * the keywords `code issue`, `contract issue`, `propose`, plus the literal
 * substrings `[A]` and `[B]`.
 */

import type { EffectPolicyDeclaration } from "@stele/core";

/**
 * Canonical contract-issue branch text (option B). The text reaches the
 * agent verbatim so it knows the exact command + rationale shape required.
 */
export function proposeExitText(policyId: string): string {
  return [
    `[B] Contract issue — the policy itself is wrong/outdated/no-longer-applicable:`,
    `    1. Do NOT edit the contract directly — it is protected from agent modifications.`,
    `    2. Investigate: read related code, run \`git log\` on the policy's source, run \`stele why ${policyId}\` for context.`,
    `    3. Document: write a rationale containing (a) scenarios researched, (b) evidence the policy no longer applies, (c) alternatives considered, (d) impact analysis.`,
    `    4. Submit a YAML proposal at \`contract/design/proposals/<id>.yaml\` containing the kind (\`effect-policy\`), the policy id (\`${policyId}\`), and the rationale from step 3. Run \`stele design propose\` to validate it (use \`invariant\` / \`branded-id\` / \`aggregate\` as the closest existing built-in type — effect-policy-specific propose subcommand is a planned follow-up). Then ask the user to review the proposal.`,
    `    5. Wait for explicit user approval before any contract change.`,
  ].join("\n");
}

/**
 * Default fix-hint for `effect.<policy>.forbidden_effect`. The hint splits
 * by `directOnNode`: when the offending effect is declared directly on the
 * node the agent should either delete the call site OR remove the
 * annotation; when inherited, the agent should refactor to drop the
 * offending callee from the reachability.
 */
export function defaultForbiddenEffectFixHint(
  policy: EffectPolicyDeclaration,
  nodeId: string,
  offendingEffect: string,
  directOnNode: boolean,
  propagationRoot: string | undefined,
  callerFile: string,
  callerLine: number,
): string {
  const location = `${callerFile}:${callerLine}`;
  const head = `Effect \`${offendingEffect}\` is forbidden in policy \`${policy.id}\` at ${location} (node \`${nodeId}\`).`;
  const aBranch = directOnNode
    ? [
        `[A] Code issue — your function at ${location} directly declares effect \`${offendingEffect}\` via annotation.`,
        `    Either remove the offending operation OR remove the source-code annotation (e.g. \`@stele:effects\` / \`@stele.effects\`).`,
        `    Only drop the annotation when you have verified the operation is truly side-effect-free.`,
      ].join("\n")
    : [
        `[A] Code issue — your function at ${location} inherits effect \`${offendingEffect}\` through a call chain.`,
        `    Original declarer: \`${propagationRoot ?? "<unknown>"}\`.`,
        `    Refactor to remove the offending call from this function's reachability (introduce a boundary, lift the call out, or replace with an effect-free alternative).`,
      ].join("\n");
  return [
    head,
    ``,
    `This violation needs you to first determine: code issue or contract issue?`,
    ``,
    aBranch,
    ``,
    proposeExitText(policy.id),
    ``,
    `Choose [A] or [B] before acting. The code suggestion in [A] is ONLY valid if you have confirmed it is a code issue, not a contract issue.`,
  ].join("\n");
}

/**
 * Default fix-hint for `effect.<policy>.disallowed_effect` — fires when an
 * `allow-only` policy detects an effect outside the allow list. Same A/B
 * pattern as forbidden_effect; copy text adapted for the "not allowed"
 * framing.
 */
export function defaultDisallowedEffectFixHint(
  policy: EffectPolicyDeclaration,
  nodeId: string,
  offendingEffect: string,
  allowOnly: readonly string[],
  directOnNode: boolean,
  propagationRoot: string | undefined,
  callerFile: string,
  callerLine: number,
): string {
  const location = `${callerFile}:${callerLine}`;
  const allowedList = allowOnly.length === 0 ? "<empty — no effects allowed>" : `[${allowOnly.join(", ")}]`;
  const head = `Effect \`${offendingEffect}\` is not in the allow-only list of policy \`${policy.id}\` at ${location} (node \`${nodeId}\`). Allowed: ${allowedList}.`;
  const aBranch = directOnNode
    ? [
        `[A] Code issue — your function at ${location} directly declares effect \`${offendingEffect}\` via annotation.`,
        `    Remove the offending operation OR re-route it through an allowed effect; only drop the source-code annotation after verifying the operation is genuinely effect-free.`,
      ].join("\n")
    : [
        `[A] Code issue — your function at ${location} inherits effect \`${offendingEffect}\` through a call chain.`,
        `    Original declarer: \`${propagationRoot ?? "<unknown>"}\`.`,
        `    Refactor so this function only depends on callees whose effects fit ${allowedList}.`,
      ].join("\n");
  return [
    head,
    ``,
    `This violation needs you to first determine: code issue or contract issue?`,
    ``,
    aBranch,
    ``,
    proposeExitText(policy.id),
    ``,
    `Choose [A] or [B] before acting. The code suggestion in [A] is ONLY valid if you have confirmed it is a code issue, not a contract issue.`,
  ].join("\n");
}

/**
 * Default fix-hint for the Round 2 D-CG-5 fail-closed result:
 * `effect.unresolved_call_blocks_evaluation`. Fires when strictMode=true
 * and the node has an unresolved call that prevents static effect
 * determination. The fix is either to refactor the call (so the analyzer
 * can resolve it) or add an explicit (effect-annotation ...) covering the
 * node.
 */
export function defaultUnresolvedCallFixHint(
  policy: EffectPolicyDeclaration | undefined,
  nodeId: string,
  callerFile: string,
  callerLine: number,
): string {
  const location = `${callerFile}:${callerLine}`;
  const policyId = policy?.id ?? "<effect-system>";
  const head = `Cannot determine effects of \`${nodeId}\` statically — there is an unresolved call at ${location} (dynamic, reflective, or external).`;
  const aBranch = [
    `[A] Code issue — your function at ${location} performs a call the analyzer cannot resolve.`,
    `    Replace the dynamic/reflective invocation with a statically resolvable call (e.g. switch from \`getattr(db, "query")()\` to \`db.query()\`), or wrap the unresolved call in an explicit \`(effect-annotation (target "<this-NodeId>") (annotates <effect> ...))\` so the evaluator knows what effects to assume.`,
  ].join("\n");
  return [
    head,
    ``,
    `This violation needs you to first determine: code issue or contract issue?`,
    ``,
    aBranch,
    ``,
    proposeExitText(policyId),
    ``,
    `Choose [A] or [B] before acting. The default code suggestion in [A] is ONLY valid if you have confirmed it is a code issue, not a contract issue. Round 2 D-CG-5: unresolved calls fail closed by default — opt out with \`--no-strict-effects\` if you accept the analysis gap.`,
  ].join("\n");
}
