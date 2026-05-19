export type DesignDiffOptions = {
  from?: string;
  json?: boolean;
};

export async function runDesignDiff(_opts: DesignDiffOptions): Promise<void> {
  process.stdout.write("[design] Diff: coming soon.\n");
}
