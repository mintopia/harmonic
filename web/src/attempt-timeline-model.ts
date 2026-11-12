import { formatScheduledJobDuration } from './scheduled-jobs-model.js';
import type { Attempt, AttemptState, AttemptSummary } from './types.js';

export type TimelineTone = 'running' | 'passed' | 'failed' | 'neutral';

export function attemptTone(state: AttemptState): TimelineTone {
  if (state === 'running') return 'running';
  if (state === 'passed') return 'passed';
  if (state === 'failed' || state === 'escalated') return 'failed';
  return 'neutral';
}

export function elapsed(startedAt: number | null, endedAt: number | null, now: number): string {
  if (startedAt === null) return '—';
  const ms = Math.max(0, (endedAt ?? now) - startedAt);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function continuationLabel(continuation: Attempt['continuation']): string | null {
  if (!continuation) return null;
  return continuation.path === 'continued-session' ? 'continued session' : 'new session, condensed';
}

const fmtTokens = (n: number): string => (n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n));

/** The recorded inputs the continuation rule decided on: context occupancy in
 * tokens against its reuse token limit, and session idle age against the warm
 * window. */
export function continuationDetail(continuation: Attempt['continuation']): string | null {
  if (!continuation) return null;
  const tokens = continuation.contextTokens === null ? 'unknown' : fmtTokens(continuation.contextTokens);
  return [
    `context ${tokens}/${fmtTokens(continuation.contextReuseTokenLimit)}`,
    `active ${formatScheduledJobDuration(continuation.lastActiveAgeMs)}/${formatScheduledJobDuration(continuation.warmWindowMs) ?? 'unknown'}`,
  ].join(' · ');
}

/** An Attempt summary carries every corrective turn it drove and `run.number`
 * is the last of them, so the summary that owns Attempt N is the earliest one
 * whose counter reached N. */
export function runForAttempt(runs: readonly AttemptSummary[], attempt: Pick<Attempt, 'number'>): AttemptSummary | null {
  let owner: AttemptSummary | null = null;
  for (const run of runs) {
    if (run.number < attempt.number) continue;
    if (!owner || run.number < owner.number) owner = run;
  }
  return owner;
}

export function runFailureBannerLabel(run: AttemptSummary | null | undefined, attempt: Pick<Attempt, 'continuation'> | null | undefined): string | null {
  if (run?.state !== 'failed' || !run.reason) return null;
  return attempt?.continuation ? 'Resume failed' : 'Attempt failed';
}
