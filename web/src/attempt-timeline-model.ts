import type { Attempt, AttemptTask, AttemptTaskState } from './types.js';

export type TimelineTone = 'running' | 'passed' | 'failed' | 'neutral';

export function taskLabel(task: AttemptTask): string {
  switch (task.type) {
    case 'rebase': return 'Rebase';
    case 'implementation': return 'Implementation';
    case 'verification': return task.command ? `Verify · ${task.command}` : 'Verification';
    case 'review': return 'Review';
  }
}

export function stateTone(state: AttemptTaskState): TimelineTone {
  if (state === 'running') return 'running';
  if (state === 'passed') return 'passed';
  if (state === 'failed') return 'failed';
  return 'neutral';
}

export function elapsed(startedAt: number | null, endedAt: number | null, now: number): string {
  if (startedAt === null) return '—';
  const ms = Math.max(0, (endedAt ?? now) - startedAt);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Feedback is recorded when the next corrective Attempt is created, so show
 * it against the failure that caused it rather than hiding it on the retry. */
export function feedbackForAttempt(attempts: readonly Attempt[], attempt: Attempt): string | null {
  if (attempt.state !== 'failed') return null;
  return attempts.find((candidate) => candidate.number === attempt.number + 1)?.feedback ?? null;
}

export function continuationLabel(attempt: Attempt): string {
  return attempt.number > 1 ? 'new session, condensed' : 'new session';
}

export function verificationAttemptId(locator: string | null): number | null {
  const match = /^verification_attempt:(\d+)$/.exec(locator ?? '');
  return match ? Number(match[1]) : null;
}

/** Latest verification proof wins; older Attempt facts are historical only. */
export function verifiedSha(attempts: readonly Attempt[]): string | null {
  for (const attempt of [...attempts].reverse()) {
    for (const task of [...attempt.tasks].reverse()) {
      if ((task.type === 'verification' || task.type === 'review') && task.verifiedSha !== null) return task.verifiedSha;
    }
  }
  return null;
}
