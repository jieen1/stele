/**
 * Closeout 4 — Test B per lifecycle (CC-13 paired negative).
 *
 * Test A (in `contract/checker_impls/test_negative.py`) mutates a pinned
 * `.test-d.ts` site so the typed-wrapper brand fires TS2345 from
 * `tsc --noEmit`. Test B has a DIFFERENT shape: it asserts that when
 * the contract's `(type-state-binding ...)` declared state disagrees
 * with the static inference for the same parameter inside the bound
 * function, the runtime evaluator emits
 *   typestate.<LIFECYCLE>.wrong_state_at_binding.
 *
 * Each test below mirrors one production binding:
 *   - MANIFEST       → writeLockedManifest (param 0 state Locked)
 *   - APPROVAL       → writeSignedApproval (param 0 state Signed)
 *   - DESIGN_PROFILE → useHashedProfile   (param 0 state Hashed)
 *   - CALLGRAPH      → useCachedCallGraph (param 0 state Cached)
 *
 * The fixture supplies an inference whose `inferredState` differs from
 * the binding's declared state. The evaluator MUST emit the new rule.
 * Reverting the inference to match the binding makes the rule
 * disappear (asserted at the bottom of each test).
 */

import { describe, expect, it } from "vitest";

import { evaluateTypeStates } from "../src/evaluator.js";
import {
  StubExtractor,
  mkBinding,
  mkCallGraph,
  mkContract,
  mkEdge,
  mkInference,
  mkNode,
  mkTypeStateDecl,
} from "./fixtures/helpers.js";

interface LifecycleSpec {
  readonly id: string;
  readonly target: string;
  readonly states: readonly string[];
  readonly bindingFunction: string;
  readonly bindingState: string; // the binding's declared state
  readonly inferredWrongState: string; // a different state from `states`
  readonly internalMethod: string;
}

const LIFECYCLES: readonly LifecycleSpec[] = [
  {
    id: "MANIFEST_LIFECYCLE",
    target: "src/manifest/lifecycle.ts::Manifest",
    states: ["Unloaded", "Loaded", "Locked", "Verified"],
    bindingFunction: "src/manifest/lifecycle.ts::writeLockedManifest(2)",
    bindingState: "Locked",
    inferredWrongState: "Loaded",
    internalMethod: "valueOf",
  },
  {
    id: "APPROVAL_LIFECYCLE",
    target: "src/commands/design/approval-lifecycle.ts::Approval",
    states: ["Drafting", "IdentityChecked", "Signed"],
    bindingFunction: "src/commands/design/approval-lifecycle.ts::writeSignedApproval(2)",
    bindingState: "Signed",
    inferredWrongState: "Drafting",
    internalMethod: "valueOf",
  },
  {
    id: "DESIGN_PROFILE_LIFECYCLE",
    target: "src/design-profile/lifecycle.ts::TypedDesignProfile",
    states: ["Raw", "Validated", "Hashed"],
    bindingFunction: "src/design-profile/lifecycle.ts::useHashedProfile(1)",
    bindingState: "Hashed",
    inferredWrongState: "Raw",
    internalMethod: "valueOf",
  },
  {
    id: "CALLGRAPH_LIFECYCLE",
    target: "src/call-graph-core/lifecycle.ts::TypedCallGraph",
    states: ["Empty", "Building", "Built", "Cached"],
    bindingFunction: "src/commands/check-stages-call-graph-cache.ts::useCachedCallGraph(1)",
    bindingState: "Cached",
    inferredWrongState: "Building",
    internalMethod: "valueOf",
  },
];

for (const spec of LIFECYCLES) {
  describe(`closeout-4 Test B — ${spec.id} wrong_state_at_binding`, () => {
    const targetFile = spec.target.split("::")[0]!;
    const targetType = spec.target.split("::")[1]!;
    const TARGET_METHOD_NODE = `${targetFile}::${targetType}::${spec.internalMethod}(0)`;

    const decl = mkTypeStateDecl({
      id: spec.id,
      target: spec.target,
      states: spec.states,
      initial: spec.states[0]!,
      // No transitions / allowedOps — the fixture is wrong_state_at_binding only.
    });

    function graphWithInternalCall() {
      return mkCallGraph({
        nodes: [
          mkNode({ id: spec.bindingFunction, filePath: spec.bindingFunction.split("::")[0]! }),
          mkNode({ id: TARGET_METHOD_NODE, filePath: targetFile }),
        ],
        edges: [
          mkEdge({ from: spec.bindingFunction, to: TARGET_METHOD_NODE, line: 10, column: 3 }),
        ],
      });
    }

    it(`emits typestate.${spec.id}.wrong_state_at_binding when binding ${spec.bindingState} disagrees with inferred ${spec.inferredWrongState}`, async () => {
      const binding = mkBinding({
        function: spec.bindingFunction,
        params: [{ index: 0, state: spec.bindingState }],
      });
      const result = await evaluateTypeStates({
        contract: mkContract({
          typeStates: [decl],
          typeStateBindings: [binding],
        }),
        callGraph: graphWithInternalCall(),
        extractor: new StubExtractor([
          mkInference({
            callerId: spec.bindingFunction,
            line: 10,
            column: 3,
            method: spec.internalMethod,
            declarationId: spec.id,
            inferredState: spec.inferredWrongState,
            receiverParamIndex: 0,
          }),
        ]),
      });
      const matching = result.violations.filter(
        (v) => v.rule_id === `typestate.${spec.id}.wrong_state_at_binding`,
      );
      expect(matching).toHaveLength(1);
      expect(matching[0]!.priority).toBe("blocking");
      expect(matching[0]!.severity).toBe("error");
      expect(matching[0]!.cause.detail).toContain(
        `binding_declared_state: ${spec.bindingState}`,
      );
      expect(matching[0]!.cause.detail).toContain(
        `inferred_state: ${spec.inferredWrongState}`,
      );
    });

    it(`does NOT fire when the inferred state agrees with the binding's ${spec.bindingState}`, async () => {
      const binding = mkBinding({
        function: spec.bindingFunction,
        params: [{ index: 0, state: spec.bindingState }],
      });
      const result = await evaluateTypeStates({
        contract: mkContract({
          typeStates: [decl],
          typeStateBindings: [binding],
        }),
        callGraph: graphWithInternalCall(),
        extractor: new StubExtractor([
          mkInference({
            callerId: spec.bindingFunction,
            line: 10,
            column: 3,
            method: spec.internalMethod,
            declarationId: spec.id,
            inferredState: spec.bindingState,
            receiverParamIndex: 0,
          }),
        ]),
      });
      const matching = result.violations.filter(
        (v) => v.rule_id === `typestate.${spec.id}.wrong_state_at_binding`,
      );
      expect(matching).toHaveLength(0);
    });
  });
}
