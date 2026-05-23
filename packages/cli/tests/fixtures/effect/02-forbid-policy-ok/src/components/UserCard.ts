/**
 * A pure UI component — receives data via props, never touches db/http.
 * `NO_IO_IN_UI` permits this because the propagated effect set is empty.
 */
export function UserCard(props: { name: string }): string {
  return `<div>${props.name}</div>`;
}
