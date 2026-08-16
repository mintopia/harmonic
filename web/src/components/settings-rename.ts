/** Rename one key of an insertion-ordered record, preserving its position.
 *
 * Returns the SAME object reference (a no-op) when the rename can't safely
 * apply — the trimmed name is empty, unchanged, or would collide with a
 * different existing row — so a commit-on-blur caller never clobbers another
 * row. On a real rename returns a fresh object with the value moved to the new
 * key in the old key's position. Collision is an OWN-key test, so renaming to
 * an inherited name like `toString` is allowed rather than falsely blocked. */
export function renameRecordKey<V>(obj: Record<string, V>, oldKey: string, rawNewKey: string): Record<string, V> {
  const newKey = rawNewKey.trim();
  if (newKey === oldKey || newKey === '' || Object.prototype.hasOwnProperty.call(obj, newKey)) return obj;
  const next: Record<string, V> = {};
  for (const [k, v] of Object.entries(obj)) next[k === oldKey ? newKey : k] = v;
  return next;
}
