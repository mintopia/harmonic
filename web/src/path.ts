/** Splits a filesystem path into its parent (free to truncate) and final
 * segment (the folder the operator recognises, kept whole). A trailing slash
 * is ignored; a path with no slash is all tail. Used by <PathTail> to keep a
 * working directory's meaningful end visible when a row runs out of width,
 * rather than losing the tail to a right-edge ellipsis. */
export function splitPathTail(path: string): { head: string; tail: string } {
  const trimmed = path.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  if (cut < 0) return { head: '', tail: trimmed || path };
  return { head: trimmed.slice(0, cut + 1), tail: trimmed.slice(cut + 1) };
}
