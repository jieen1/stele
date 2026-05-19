export type DesignProposeOptions = {
  id?: string;
  description?: string;
  evolvability?: string;
  typeName?: string;
  target?: string;
};

export async function runDesignPropose(_type: string, _opts: DesignProposeOptions): Promise<void> {
  process.stdout.write("[design] Propose: coming soon.\n");
}
