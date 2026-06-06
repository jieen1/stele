export type {
  SupportedLanguage,
  SourceSpan,
  TypeStateAnnotation,
  CallGraphNode,
  CallGraphEdge,
  UnresolvedCall,
  AmbiguousCall,
  CallGraph,
  ExtractOptions,
  CallGraphExtractor,
} from "./types.js";
export { ALL_LANGUAGES } from "./types.js";

export {
  parseNodeId,
  formatNodeId,
  computeDisambiguator,
  type ParsedNodeId,
} from "./node-id.js";

export {
  matchPattern,
  compilePattern,
  type CompiledPattern,
} from "./pattern-matcher.js";

export {
  buildExternAliasRegistry,
  resolveExternPattern,
  type ExternAlias,
  type ExternAliasRegistry,
} from "./extern-alias.js";

export type {
  CallGraphState,
  CallGraphStateBrand,
  TypedCallGraph,
  ConsumableCallGraph,
} from "./lifecycle.js";
export {
  cacheCallGraph,
  emptyCallGraph,
  finalizeCallGraph,
  startBuilding,
} from "./lifecycle.js";
