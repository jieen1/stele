import { processRequest } from "../core/service.js";
import { connect } from "../infra/database.js";

export async function handleRequest(req: { method: string }): Promise<{ status: number }> {
  connect();
  const result = processRequest(req);
  return { status: 200 };
}
