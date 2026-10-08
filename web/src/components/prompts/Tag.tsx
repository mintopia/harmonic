import type { ReactNode } from 'react';

type TagTone = 'fragment' | 'conditional' | 'modified' | 'fail' | 'accent';

const TAG_TONE: Record<TagTone, string> = {
  fragment: 'bg-raised text-muted',
  conditional: 'border border-dashed border-edge-strong text-faint',
  modified: 'bg-running-tint text-running',
  fail: 'bg-fail-tint text-fail',
  accent: 'bg-accent-tint text-accent',
};

export function Tag({ tone, title, children }: { tone: TagTone; title?: string; children: ReactNode }) {
  return (
    <span title={title} className={`min-w-0 max-w-full rounded-xl px-2 py-0.5 text-small ${TAG_TONE[tone]}`}>
      {children}
    </span>
  );
}
