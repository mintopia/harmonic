import type { ReactNode } from 'react';
import { btnQuietInk } from '../ui';

const TONE = {
  ready: 'border-l-ready bg-ready-tint',
  await: 'border-l-await bg-await-tint',
} as const;

const DOT = {
  ready: 'bg-ready-dot',
  await: 'bg-await-dot',
} as const;

export function HintBanner({ tone, onDismiss, children }: { tone: keyof typeof TONE; onDismiss: () => void; children: ReactNode }) {
  return (
    <div className={`mx-6 mt-4 flex shrink-0 items-start gap-3 rounded-lg border-l-4 px-4 py-2.5 text-small ${TONE[tone]}`}>
      <span aria-hidden="true" className={`mt-1 size-2 shrink-0 rounded-full ${DOT[tone]}`} />
      <p className="flex-1 text-ink">{children}</p>
      <button className={btnQuietInk} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
