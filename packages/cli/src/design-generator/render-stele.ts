// CDL renderer facade for the DDD + Type-Driven design-profile generator.
//
// The actual rendering lives in `./render/<form>.ts`; this file composes
// them and preserves the public surface that ddd.ts and existing tests
// import. Output of `renderAllDeclarations` is byte-identical to the
// pre-split implementation and is locked in by
// `tests/render-stele-snapshot.test.ts` against the protected
// `contract/generated/ddd-typedriven.stele` artifact.

export { renderContextArchitecture } from "./render/architecture.js";
export { renderAclIntegration } from "./render/context-map.js";
export { renderAggregateCoreNode, renderAggregateClassShape } from "./render/core-node.js";
export {
  renderBrandedId,
  renderSmartCtor,
  renderTypeDrivenDeclarations,
  resolveBrandedIdTarget,
} from "./render/type-driven.js";
export { renderTracePolicy, renderTraceSection } from "./render/trace.js";

/**
  * Render all declarations from a full profile into a single CDL string.
  */
export function renderAllDeclarations(
  contextArchitectures: string[],
  aclArchitecture: string | undefined,
  coreNodes: string[],
  brandedIds: string[] = [],
  smartCtors: string[] = [],
): string {
  const parts: string[] = [...contextArchitectures];
  if (aclArchitecture) {
    parts.push(aclArchitecture);
  }
  parts.push(...coreNodes);
  parts.push(...brandedIds);
  parts.push(...smartCtors);
  return parts.join("\n\n");
}
