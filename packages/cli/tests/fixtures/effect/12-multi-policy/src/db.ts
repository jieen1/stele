/** @stele:effects db.read */
export function findUser(id: string): { id: string; name: string } {
  return { id, name: `user-${id}` };
}
