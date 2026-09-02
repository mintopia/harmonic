import { createElement, useEffect, useState } from 'react';
import {
  formatScheduledJobDuration,
  formatScheduledJobLastRun,
  formatScheduledJobNextRun,
  isScheduledJobsSnapshot,
  mergeScheduledJobs,
  scheduledJobScope,
  type ScheduledJob,
} from '../scheduled-jobs-model.js';
import { subscribe } from '../ws.js';
import { card, chip, tableHead } from '../ui.js';

const GRID = 'grid grid-cols-[minmax(10rem,1.5fr)_7rem_6rem_7rem_7rem_minmax(10rem,1fr)_7rem_6rem_7rem] gap-x-4 px-4';

function empty() {
  return createElement('span', { className: 'text-muted' }, '—');
}

function OperationCell({ job }: { job: ScheduledJob }) {
  if (job.lastOperationSpanId === null) return empty();
  return createElement(
    'a',
    {
      href: `#operation-${job.lastOperationSpanId}`,
      className: 'truncate font-mono text-small text-muted hover:text-ink hover:underline',
      title: `Firing span ${job.lastOperationSpanId}`,
    },
    job.lastOperationSpanId.slice(0, 8),
  );
}

function ResultCell({ job }: { job: ScheduledJob }) {
  if (job.lastStatus === null) return empty();
  const failed = job.lastStatus === 'error';
  return createElement(
    'div',
    { className: `min-w-0 ${failed ? 'text-fail' : 'text-done'}` },
    createElement('div', { className: 'font-medium' }, failed ? 'Error' : 'OK'),
    failed && job.lastError && createElement('div', { className: 'truncate text-small', title: job.lastError }, job.lastError),
  );
}

function ScheduledJobRow({ job, now }: { job: ScheduledJob; now: number }) {
  const disabled = job.status === 'disabled';
  return createElement(
    'div',
    { role: 'row', className: `${GRID} items-center border-t border-hairline py-3 ${disabled ? 'bg-raised/60 text-muted' : ''}` },
    createElement('div', { role: 'cell', className: 'min-w-0 truncate font-medium text-ink', title: job.name }, job.name),
    createElement('div', { role: 'cell', className: 'text-small text-muted' }, scheduledJobScope(job)),
    createElement('div', { role: 'cell', className: 'tabular-nums text-small text-muted' }, formatScheduledJobDuration(job.intervalMs)),
    createElement('div', { role: 'cell', className: 'tabular-nums text-small text-muted' }, formatScheduledJobLastRun(job.lastRunAt, now) ?? empty()),
    createElement('div', { role: 'cell', className: 'tabular-nums text-small text-muted' }, formatScheduledJobDuration(job.lastDurationMs) ?? empty()),
    createElement('div', { role: 'cell' }, createElement(ResultCell, { job })),
    createElement('div', { role: 'cell', className: 'tabular-nums text-small text-muted' }, formatScheduledJobNextRun(job.nextRunAt, now) ?? empty()),
    createElement('div', { role: 'cell' }, createElement('span', { className: `${chip} ${disabled ? 'bg-raised text-muted' : 'bg-ready-tint text-ready'}` }, disabled ? 'Disabled' : 'Active')),
    createElement('div', { role: 'cell', className: 'min-w-0' }, createElement(OperationCell, { job })),
  );
}

/** A read-only snapshot plus firehose view of the scheduler's registered Jobs. */
export function ScheduledJobsTable({ jobs, now }: { jobs: ScheduledJob[]; now: number }) {
  return createElement(
    'div',
    { role: 'table', 'aria-label': 'Scheduled jobs', className: `${card} overflow-x-auto` },
    createElement(
      'div',
      { role: 'rowgroup' },
      createElement(
        'div',
        { role: 'row', className: `${GRID} min-w-[55rem] py-2.5 ${tableHead}` },
        ...['Name', 'Scope', 'Interval', 'Last run', 'Last duration', 'Result', 'Next run', 'Status', 'Operation'].map((label) =>
          createElement('span', { key: label, role: 'columnheader' }, label),
        ),
      ),
    ),
    createElement('div', { role: 'rowgroup', className: 'min-w-[55rem]' }, jobs.map((job) => createElement(ScheduledJobRow, { key: job.jobKey, job, now }))),
  );
}

export function ScheduledJobsView() {
  const [jobs, setJobs] = useState<ScheduledJob[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    let snapshotLoaded = false;
    let pending: ScheduledJob[][] = [];
    const apply = (next: ScheduledJob[]) => setJobs((current) => mergeScheduledJobs(current ?? [], next));
    const installSnapshot = (snapshot: ScheduledJob[]) => {
      if (!active) return;
      snapshotLoaded = true;
      setJobs(pending.reduce(mergeScheduledJobs, snapshot));
    };
    const load = () => {
      snapshotLoaded = false;
      pending = [];
      fetch('/api/scheduled-jobs')
        .then((response) => (response.ok ? response.json() : { jobs: [] }))
        .then((snapshot: unknown) => installSnapshot(isScheduledJobsSnapshot(snapshot) ? snapshot.jobs : []))
        .catch(() => installSnapshot([]));
    };
    const unsubscribe = subscribe((message) => {
      if (message.type !== 'scheduled-jobs') return;
      if (snapshotLoaded) apply(message.jobs);
      else pending.push(message.jobs);
    }, load);
    load();
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      active = false;
      clearInterval(timer);
      unsubscribe();
    };
  }, []);

  if (jobs === null) return createElement('p', { className: 'text-small text-muted' }, 'Loading scheduled jobs…');
  if (jobs.length === 0) return createElement('p', { className: 'text-small text-muted' }, 'No scheduled jobs registered.');
  return createElement(ScheduledJobsTable, { jobs, now });
}
