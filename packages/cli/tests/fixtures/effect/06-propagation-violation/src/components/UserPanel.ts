import { getUserProfile } from "../service.js";

/**
 * VIOLATION (transitive): UserPanel → getUserProfile → findUser (db.read).
 * NO_IO_IN_UI catches the propagated effect even though `UserPanel` never
 * imports `db.ts` directly.
 */
export function UserPanel(props: { id: string }): string {
  const u = getUserProfile(props.id);
  return `<section>${u.name}</section>`;
}
