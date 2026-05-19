export type DesignApproveOptions = {
  from?: string;
  reason?: string;
};

export async function runDesignApprove(_opts: DesignApproveOptions): Promise<void> {
  process.stdout.write("[design] Approve: coming soon.\n");
}
