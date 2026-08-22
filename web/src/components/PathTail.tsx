import { splitPathTail } from '../path';

export function PathTail({ path, className }: { path: string; className?: string }) {
  const { head, tail } = splitPathTail(path);
  return (
    <span className={`flex min-w-0 ${className ?? ''}`} title={path}>
      <span className="truncate">{head}</span>
      <span className="shrink-0">{tail}</span>
    </span>
  );
}
