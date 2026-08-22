import type { ReactNode } from 'react';

export function EmptyState({
  title,
  children,
  action,
  className = 'mt-16',
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mx-auto max-w-sm text-center ${className}`}>
      <p className="text-title font-semibold text-ink">{title}</p>
      <p className="mt-1.5 text-muted">{children}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
