import { processRequest } from "../core/service.js";

export async function handleRequest(req: { method: string }): Promise<{ status: number }> {
  const result = processRequest(req);
  return { status: 200 };
}
