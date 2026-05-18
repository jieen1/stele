export function processRequest(req: { method: string }): string {
  return req.method.toUpperCase();
}
