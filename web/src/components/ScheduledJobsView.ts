import { createElement, useState } from 'react';
import {
  formatScheduledJobDuration,
  formatScheduledJobNextRun,
  isScheduledJobsSnapshot,
  mergeScheduledJobs,
  type ScheduledJob,
} from '../scheduled-jobs-model.js';
import { subscribe } from '../ws.js';
import { card, labelType } from '../ui.js';
import { useLiveEffect } from '../useLiveEffect.js';

const STRIP = 'grid grid-cols-[minmax(10rem,1.5fr)_minmax(5rem,auto)_minmax(6rem,auto)_minmax(6rem,1fr)] items-center gap-x-4 px-4';

function empty() {
  return createElement('span', { className: 'text-muted' }, '—');
}

function ResultCell({ job }: { job: ScheduledJob }) {
  if (job.lastStatus === null) return empty();
  const failed = job.lastStatus === 'error';
  return createElement(
    'span',
    {
      'aria-label': failed && job.lastError ? `Error: ${job.lastError}` : undefined,
      className: `font-medium ${failed ? 'text-fail' : 'text-done'}`,
      title: failed ? job.lastError ?? undefined : undefined,
    },
    failed ? 'Error' : 'OK',
  );
}

function ScheduledJobRow({ job, now }: { job: ScheduledJob; now: number }) {
  const disabled = job.status === 'disabled';
  return createElement(
    'li',
    { className: `border-t border-hairline ${disabled ? 'bg-raised/60' : ''}` },
    createElement(
      'dl',
      { className: `${STRIP} py-3` },
      createElement('div', { className: 'min-w-0' }, createElement('dt', { className: 'sr-only' }, 'Name'), createElement('dd', { className: 'truncate font-medium text-ink', title: job.name }, job.name)),
      createElement('div', null, createElement('dt', { className: 'sr-only' }, 'Cadence'), createElement('dd', { className: 'tabular-nums text-small text-muted' }, formatScheduledJobDuration(job.intervalMs))),
      createElement('div', null, createElement('dt', { className: 'sr-only' }, 'Next run'), createElement('dd', { className: 'tabular-nums text-small text-muted' }, formatScheduledJobNextRun(job.nextRunAt, now) ?? empty())),
      createElement('div', { className: 'min-w-0' }, createElement('dt', { className: 'sr-only' }, 'Result'), createElement('dd', null, createElement(ResultCell, { job }))),
    ),
  );
}

/** A read-only snapshot plus firehose view of the scheduler's registered Jobs. */
export function ScheduledJobsTable({ jobs, now }: { jobs: ScheduledJob[]; now: number }) {
  return createElement(
    'div',
    { className: card },
    createElement('div', { className: `border-b border-hairline px-4 py-3 ${labelType} text-muted` }, 'Scheduled jobs'),
    createElement(
      'div',
      { 'aria-hidden': true, className: `${STRIP} py-2.5 ${labelType} text-muted` },
      ...['Name', 'Cadence', 'Next run', 'Result'].map((label) => createElement('span', { key: label }, label)),
    ),
    createElement('ul', { 'aria-label': 'Scheduled jobs' }, jobs.map((job) => createElement(ScheduledJobRow, { key: job.jobKey, job, now }))),
  );
}

export function ScheduledJobsView() {
  const [jobs, setJobs] = useState<ScheduledJob[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useLiveEffect((live) => {
    let snapshotLoaded = false;
    let pending: ScheduledJob[][] = [];
    const apply = (next: ScheduledJob[]) => setJobs((current) => mergeScheduledJobs(current ?? [], next));
    const installSnapshot = (snapshot: ScheduledJob[]) => {
      if (!live()) return;
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
      clearInterval(timer);
      unsubscribe();
    };
  }, []);

  if (jobs === null) return createElement('p', { className: 'text-small text-muted' }, 'Loading scheduled jobs…');
  if (jobs.length === 0) return createElement('p', { className: 'text-small text-muted' }, 'No scheduled jobs registered.');
  return createElement(ScheduledJobsTable, { jobs, now });
}
