import { splitPathTail } from '../path';

/**
 * A filesystem path that keeps its final segment — the folder the operator
 * actually recognises — whole when space runs out, rather than losing its tail
 * to a right-edge ellipsis (`/Users/mintopia/Proje…` hides the one part that
 * matters). The parent truncates instead, and the full path is on hover.
 * Reused wherever a working directory is shown in a tight row (the conversation
 * header, the permission-rules list). The caller supplies `font-data` and any
 * colour/flex classes via `className`; this only owns the split behaviour.
 */
export function PathTail({ path, className }: { path: string; className?: string }) {
  const { head, tail } = splitPathTail(path);
  return (
    <span className={`flex min-w-0 ${className ?? ''}`} title={path}>
      <span className="truncate">{head}</span>
      <span className="shrink-0">{tail}</span>
    </span>
  );
}
