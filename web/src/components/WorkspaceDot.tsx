import type { Workspace } from '../types';

export function WorkspaceDot({ workspace, size = 'sm', className = '' }: { workspace: Pick<Workspace, 'name' | 'color'>; size?: 'sm' | 'md'; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center justify-center rounded-full font-bold text-[#1b1e24] ${size === 'sm' ? 'size-4 text-[9px]' : 'size-5 text-[10px]'} ${className}`}
      style={{ backgroundColor: workspace.color }}
    >
      {workspace.name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
