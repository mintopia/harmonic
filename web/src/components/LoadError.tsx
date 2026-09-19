import type { ReactElement } from 'react';
import { btnGhost, touchTargetInline } from '../ui';

/** Block banner variant of a failed-load state: `role="alert"` plus the
 * `rounded-lg bg-fail-tint px-4 py-2 text-fail` markup used across the app's
 * failed-load banners, plus a Retry action. */
export function LoadError({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry: () => void;
  className?: string;
}): ReactElement {
  return (
    <div
      role="alert"
      className={`flex items-center justify-between gap-3 rounded-lg bg-fail-tint px-4 py-2 text-fail${className ? ` ${className}` : ''}`}
    >
      <span>Failed to load — {message}</span>
      <button type="button" onClick={onRetry} className={btnGhost}>
        Retry
      </button>
    </div>
  );
}

/** Compact one-line variant for inline contexts (a form field, a modal) where
 * the full {@link LoadError} banner would be too heavy. */
export function LoadErrorNote({ message, onRetry }: { message: string; onRetry: () => void }): ReactElement {
  return (
    <p role="alert" className="text-small text-fail">
      Failed to load — {message}{' '}
      <button type="button" onClick={onRetry} className={`${touchTargetInline} underline font-medium`}>
        Retry
      </button>
    </p>
  );
}
