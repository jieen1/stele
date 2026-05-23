import { findUser } from "../db.js";

/**
 * VIOLATION #1 — NO_IO_IN_UI catches db.read here.
 */
export function UserCard(props: { id: string }): string {
  const u = findUser(props.id);
  return `<div>${u.name}</div>`;
}
