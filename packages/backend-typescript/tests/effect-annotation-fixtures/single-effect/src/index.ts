/** @stele:effects db.read */
export function getUser(id: string): { id: string } {
  return { id };
}

export function plain(): void {}
