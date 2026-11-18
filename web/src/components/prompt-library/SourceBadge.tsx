import type { ReactNode } from 'react';

const TONES = {
  bundled: 'bg-raised text-muted',
  yours: 'bg-accent-tint text-accent',
  used: 'bg-ready-tint text-ready',
  fragment: 'bg-await-tint text-await',
} as const;

export type TagTone = keyof typeof TONES;

export function Tag({ tone, children }: { tone: TagTone; children: ReactNode }) {
  return <span className={`inline-flex whitespace-nowrap rounded-sm px-1.5 py-px font-data text-[10.5px] ${TONES[tone]}`}>{children}</span>;
}

export function SourceBadge({ bundled }: { bundled: boolean }) {
  return <Tag tone={bundled ? 'bundled' : 'yours'}>{bundled ? 'bundled' : 'yours'}</Tag>;
}
