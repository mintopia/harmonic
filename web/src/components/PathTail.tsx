import { splitPathTail } from '../path';

export function PathTail({ path, display, className }: { path: string; display?: string; className?: string }) {
  const { head, tail } = splitPathTail(display ?? path);
  return (
    <span className={`flex min-w-0 ${className ?? ''}`} title={path}>
      <span className="truncate">{head}</span>
      <span className="shrink-0">{tail}</span>
    </span>
  );
}
