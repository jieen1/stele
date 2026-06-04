/**
 * stele mcp — Bridge to the @stele/mcp-server package.
 *
 * Uses a DYNAMIC import (not a static top-level one) so @stele/cli carries no
 * static value dependency on @stele/mcp-server. That direction would form a
 * runtime value cycle: @stele/mcp-server statically imports the incident lib
 * (`runIncident*`) from @stele/cli, so a static cli→mcp-server import would be
 * a mutual load-time cycle and risk ESM init-order bugs. The dynamic import is
 * resolved only when `stele mcp` actually runs — cli is already loaded by then,
 * so mcp-server's import of cli resolves to the in-flight module.
 */
export async function startMcpServer(): Promise<void> {
  const { SteleMcpServer } = await import("@stele/mcp-server");
  const server = new SteleMcpServer();
  await server.start();
}
