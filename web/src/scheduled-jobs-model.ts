/** The API's complete, ordered registry snapshot for one recurring Job. */
export interface ScheduledJob {
  jobKey: string;
  name: string;
  workspaceId: number | null;
  intervalMs: number;
  status: 'active' | 'disabled';
  lastRunAt: number | null;
  lastStatus: 'ok' | 'error' | null;
  lastDurationMs: number | null;
  lastError: string | null;
  /** The OTel span id of this Job's most recent firing this process; null before its first run since boot. */
  lastOperationSpanId: string | null;
  nextRunAt: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isScheduledJob(value: unknown): value is ScheduledJob {
  if (!isRecord(value)) return false;
  return typeof value.jobKey === 'string'
    && typeof value.name === 'string'
    && isNullableNumber(value.workspaceId)
    && typeof value.intervalMs === 'number'
    && (value.status === 'active' || value.status === 'disabled')
    && isNullableNumber(value.lastRunAt)
    && (value.lastStatus === null || value.lastStatus === 'ok' || value.lastStatus === 'error')
    && isNullableNumber(value.lastDurationMs)
    && isNullableString(value.lastError)
    && isNullableString(value.lastOperationSpanId)
    && isNullableNumber(value.nextRunAt);
}

/** Validates the API/firehose registry at the browser boundary. */
export function isScheduledJobsSnapshot(value: unknown): value is { jobs: ScheduledJob[] } {
  return isRecord(value) && Array.isArray(value.jobs) && value.jobs.every(isScheduledJob);
}

/**
 * A scheduled-jobs event is a complete registry snapshot, not a delta. Replacing
 * the prior list removes Jobs that were unregistered while the view was open.
 */
export function mergeScheduledJobs(_previous: readonly ScheduledJob[], next: readonly ScheduledJob[]): ScheduledJob[] {
  return [...next];
}

export function scheduledJobScope(job: ScheduledJob): 'Global' | 'Workspace' {
  return job.workspaceId === null ? 'Global' : 'Workspace';
}

export function formatScheduledJobDuration(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 1_000) return `${ms}ms`;
  const seconds = ms / 1_000;
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds % 1 === 0 ? seconds : seconds.toFixed(1)}s`;
}

export function formatScheduledJobLastRun(timestamp: number | null, now: number): string | null {
  if (timestamp === null) return null;
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return seconds === 0 ? 'now' : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatScheduledJobNextRun(timestamp: number | null, now: number): string | null {
  if (timestamp === null) return null;
  const seconds = Math.max(0, Math.ceil((timestamp - now) / 1_000));
  if (seconds < 60) return seconds === 0 ? 'now' : `in ${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  return `in ${Math.ceil(minutes / 60)}h`;
}
