export {
  getTypeScriptRuntimeSource,
  getTypeScriptSetupSource,
  TYPESCRIPT_RUNTIME_PATH,
  TYPESCRIPT_SETUP_PATH,
} from "./runtime.js";
export {
  astToSource,
  generateVitestSource,
  sanitizeTsIdentifier,
  translateExpression,
} from "./translator.js";
export type { TranslationContext } from "./translator.js";
export { default, default as backend } from "./backend.js";
export {
  renderArchitectureTest,
  toMinimalArchitecture,
} from "./architecture-renderer.js";
export type {
  MinimalArchitecture,
  MinimalModule,
  MinimalAllowDependency,
} from "./architecture-renderer.js";
export type {
  ArchitectureContractOptions,
  ArchitectureViolation,
} from "./architecture-runtime.js";
export * from "./extractors/index.js";
