export { checkBrandedIds } from "./branded-id-checker.js";
export {
  runTypeDrivenChecks,
  type TypeDrivenCheckOptions,
  type TypeDrivenCheckResult,
} from "./unified-checker.js";
export type {
  BrandedIdDeclaration,
  BrandedIdViolation,
  BrandedIdCheckOptions,
  BrandedIdCheckResult,
  BrandedIdCoverage,
} from "./types.js";
export {
  createShapeProgram,
  clearProgramCache,
  findSourceFile,
  findNamedDeclaration,
  type ShapeProgram,
  type ShapeProgramOptions,
} from "./program.js";
