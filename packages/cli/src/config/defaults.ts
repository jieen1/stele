export const STELE_CONFIG_FILE = "stele.config.json";
export const STELE_BASELINE_FILE = "contract/.baseline.json";

export type SteleConfig = {
  version: string;
  contractDir: string;
  entry: string;
  generatedDir: string;
  checkerImplDir: string;
  manifestPath: string;
  targetLanguage: string;
  testFramework: string;
  pathMode: string;
  protected: string[];
};

export const DEFAULT_CONFIG: SteleConfig = {
  version: "0.1",
  contractDir: "contract",
  entry: "contract/main.stele",
  generatedDir: "tests/contract",
  checkerImplDir: "contract/checker_impls",
  manifestPath: "contract/.manifest.json",
  targetLanguage: "python",
  testFramework: "pytest",
  pathMode: "auto",
  protected: [
    "contract/**/*.stele",
    "contract/checker_impls/**/*",
    STELE_BASELINE_FILE,
    "contract/.manifest.json",
    "tests/contract/**/*",
  ],
};
