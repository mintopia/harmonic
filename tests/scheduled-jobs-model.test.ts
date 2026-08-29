import { describe, expect, it } from 'vitest';
import {
  formatScheduledJobDuration,
  formatScheduledJobLastRun,
  formatScheduledJobNextRun,
  isScheduledJobsSnapshot,
  mergeScheduledJobs,
  scheduledJobScope,
  type ScheduledJob,
} from '../web/src/scheduled-jobs-model.js';

const job = (overrides: Partial<ScheduledJob> = {}): ScheduledJob => ({
  jobKey: 'tracker-poll:global',
  name: 'Tracker poll',
  workspaceId: null,
  intervalMs: 60_000,
  status: 'active',
  lastRunAt: 1_000,
  lastStatus: 'ok',
  lastDurationMs: 50,
  lastError: null,
  lastOperationSpanId: null,
  nextRunAt: 61_000,
  ...overrides,
});

describe('scheduled jobs read model (issue #302)', () => {
  it('replaces the registry snapshot when a scheduled-jobs firehose event arrives', () => {
    const previous = [job(), job({ jobKey: 'old:global', name: 'Old job' })];
    const changed = job({ status: 'disabled', nextRunAt: null });

    expect(mergeScheduledJobs(previous, [changed])).toEqual([changed]);
  });

  it('formats the scheduler facts without inventing a disabled job next run', () => {
    expect(scheduledJobScope(job())).toBe('Global');
    expect(scheduledJobScope(job({ workspaceId: 2 }))).toBe('Workspace');
    expect(formatScheduledJobDuration(1_500)).toBe('1.5s');
    expect(formatScheduledJobLastRun(1_000, 62_000)).toBe('1m ago');
    expect(formatScheduledJobNextRun(122_000, 62_000)).toBe('in 1m');
    expect(formatScheduledJobNextRun(null, 62_000)).toBeNull();
  });

  it('accepts only complete scheduler snapshots at the browser boundary', () => {
    expect(isScheduledJobsSnapshot({ jobs: [job()] })).toBe(true);
    expect(isScheduledJobsSnapshot({ jobs: [{ name: 'missing facts' }] })).toBe(false);
  });
});
