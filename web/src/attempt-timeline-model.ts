import { formatScheduledJobDuration } from './scheduled-jobs-model.js';
import type { Attempt, AttemptState, AttemptTask, AttemptTaskState, Run } from './types.js';

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

/** The recorded inputs the continuation rule decided on: context occupancy
 * against its reuse threshold, and session idle age against the warm window. */
export function continuationDetail(continuation: Attempt['continuation']): string | null {
  if (!continuation) return null;
  return [
    `context ${continuation.contextUsage ?? 'unknown'}/${continuation.contextReuseThreshold}`,
    `active ${formatScheduledJobDuration(continuation.lastActiveAgeMs)}/${formatScheduledJobDuration(continuation.warmWindowMs) ?? 'unknown'}`,
  ].join(' · ');
}

export function verificationAttemptId(locator: string | null): number | null {
  const match = /^verification_attempt:(\d+)$/.exec(locator ?? '');
  return match ? Number(match[1]) : null;
}

/** Latest verification proof wins; older Attempt facts are historical only. */
export function verifiedSha(attempts: readonly Attempt[]): string | null {
  for (const attempt of [...attempts].reverse()) {
    if (attempt.verifiedSha !== null) return attempt.verifiedSha;
  }
  return null;
}

/** A Run carries every corrective Attempt it drove and `run.attempt` is the
 * last of them, so the Run that owns Attempt N is the earliest one whose
 * counter reached N. */
export function runForAttempt(runs: readonly Run[], attempt: Pick<Attempt, 'number'>): Run | null {
  let owner: Run | null = null;
  for (const run of runs) {
    if (run.attempt < attempt.number) continue;
    if (!owner || run.attempt < owner.attempt) owner = run;
  }
  return owner;
}

export function runFailureBannerLabel(run: Run | null | undefined, attempt: Pick<Attempt, 'continuation'> | null | undefined): string | null {
  if (run?.state !== 'failed' || !run.reason) return null;
  return attempt?.continuation ? 'Resume failed' : 'Run failed';
}

export type TaskLogSource =
  | { kind: 'output'; verificationAttemptId: number }
  | { kind: 'critic'; verificationAttemptId: number }
  | { kind: 'run' };

/** Where a task row's log lives: command output and critic transcripts are
 * keyed by their verification attempt; implementation work is the Run's own
 * harness transcript (the ACP events the main pane already streams). */
export function taskLogSource(task: AttemptTask): TaskLogSource | null {
  const id = verificationAttemptId(task.logLocator);
  if (task.type === 'verification') return id === null ? null : { kind: 'output', verificationAttemptId: id };
  if (task.type === 'review') return id === null ? null : { kind: 'critic', verificationAttemptId: id };
  return { kind: 'run' };
}
