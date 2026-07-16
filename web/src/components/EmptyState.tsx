import type { ReactNode } from 'react';

/**
 * One consistent empty state across the app (DESIGN.md: an empty screen is an
 * invitation to act). It says what goes here, why it matters, and — optionally —
 * offers the single action that fills it. Typographic and calm: no illustration,
 * because agents are processes, not mascots. The caller owns vertical placement
 * via `className` (a roomy full view vs a compact docked panel).
 */
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
