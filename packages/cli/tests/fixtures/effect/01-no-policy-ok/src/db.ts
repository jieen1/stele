/** @stele:effects db.read */
export function findUser(id: string): { id: string; name: string } {
  return { id, name: `user-${id}` };
}

/** @stele:effects db.write */
export function saveUser(user: { id: string; name: string }): void {
  void user;
}
