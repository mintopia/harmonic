import { statePill } from '../../ui';
import type { TimelineTone } from '../../attempt-timeline-model';

export const sectionCaps = 'text-label font-bold uppercase tracking-[0.1em] text-faint';

export function humanState(state: string): string {
  return state.replace(/-/g, ' ');
}

export function StatePill({ state }: { state: string }) {
  return <span className={statePill(state)}>{humanState(state)}</span>;
}

export const NAV_DOT: Record<TimelineTone, string> = {
  running: 'bg-running-dot motion-safe:animate-dot-pulse',
  passed: 'bg-merged-dot',
  failed: 'bg-fail-dot',
  neutral: 'bg-edge',
};

export const NAV_WORD: Record<TimelineTone, string> = {
  running: 'text-running',
  passed: 'text-merged',
  failed: 'text-fail',
  neutral: 'text-muted',
};
