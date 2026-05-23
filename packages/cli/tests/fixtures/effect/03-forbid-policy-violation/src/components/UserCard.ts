import { findUser } from "../db.js";

/**
 * VIOLATION: UI component performs db.read via `findUser`. The effect
 * propagates from `findUser` (declares db.read) up to `UserCard`, which is
 * inside `src/components/**` — the target scope of `NO_IO_IN_UI`.
 */
export function UserCard(props: { id: string }): string {
  const user = findUser(props.id);
  return `<div>${user.name}</div>`;
}
