/**
 * Return a new array with the item identified by `fromId` moved to the current
 * position of `toId`. Used for drag-to-reorder of tabs. Returns the same array
 * reference when nothing would change.
 */
export function moveById<T extends { id: string }>(
  list: T[],
  fromId: string,
  toId: string,
): T[] {
  if (fromId === toId) return list;
  const from = list.findIndex((x) => x.id === fromId);
  const to = list.findIndex((x) => x.id === toId);
  if (from === -1 || to === -1) return list;
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
