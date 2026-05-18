/**
 * Architecture contract runtime types for the TypeScript backend.
 *
 * These types mirror the shapes consumed by `evaluateArchitectureContract`
 * in `@stele/cli/architecture-runtime`. The generated architecture tests
 * import the runtime function from `@stele/cli/architecture-runtime` at
 * execution time; this module provides the type declarations so the
 * backend package itself can reference them without depending on the CLI.
 */

export interface ArchitectureContractOptions {
  projectRoot: string;
  architecture: {
    id: string;
    modules: Array<{ id: string; paths: string[] }>;
    allowDependencies: Array<{ from: string; to: string[] }>;
    denyCycles: boolean;
  };
}

export interface ArchitectureViolation {
  fromModule: string;
  toModule: string;
  fromFile: string;
  specifier: string;
  line: number;
  column: number;
}
