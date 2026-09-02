import { createElement, useState, type ReactNode } from 'react';
import { operationForest, visibleOperationForest, type Operation, type OperationForest } from '../operations-model.js';
import { card, displayTitle, labelType, sectionTitle } from '../ui.js';
import { subscribe, type OperationEvent } from '../ws.js';
import { ScheduledJobsView } from './ScheduledJobsView.js';
import { FlaggedWorktreesView } from './FlaggedWorktreesView.js';
import { useLiveEffect } from '../useLiveEffect.js';

export interface OperationsPageProps {
  scheduledJobs?: ReactNode;
  spanTree?: ReactNode;
  flaggedWorktrees?: ReactNode;
}

const EMPTY_FOREST: OperationForest = { operations: [], recent: [] };

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function subject(operation: Operation): string | null {
  const taskId = operation.attributes['task.id'];
  if (typeof taskId === 'number') return `Task ${taskId}`;
  const epicRef = operation.attributes['epic.ref'];
  if (typeof epicRef === 'number') return `Epic #${epicRef}`;
  const attemptId = operation.attributes['attempt.id'];
  if (typeof attemptId === 'number') return `Attempt ${attemptId}`;
  return null;
}

function status(operation: Operation): string {
  if (operation.endedAt === null) return 'Running';
  return operation.status.code === 2 ? 'Failed' : 'Completed';
}

function OperationRow({ operation, now, depth }: { operation: Operation; now: number; depth: number }): ReactNode {
  const duration = (operation.endedAt ?? now) - operation.startedAt;
  const operationSubject = subject(operation);
  return createElement(
    'li',
    {
      id: `operation-${operation.spanId}`,
      className: 'border-t border-hairline py-2.5 first:border-t-0',
      style: { paddingLeft: `${depth * 1.25}rem` },
    },
    createElement('div', { className: 'flex flex-wrap items-baseline gap-x-3 gap-y-1' },
      createElement('span', { className: 'font-medium text-ink' }, operation.type),
      operationSubject && createElement('span', { className: 'text-small text-muted' }, operationSubject),
      createElement('span', { className: `${labelType} ${operation.endedAt === null ? 'text-running' : operation.status.code === 2 ? 'text-fail' : 'text-muted'}` }, status(operation)),
      createElement('span', { className: 'ml-auto text-small tabular-nums text-muted' }, elapsed(duration)),
    ),
    operation.children.length > 0 && createElement('ul', { className: 'mt-1' }, operation.children.map((child) =>
      createElement(OperationRow, { key: child.spanId, operation: child, now, depth: depth + 1 }),
    )),
  );
}

function OperationsReadout() {
  const [forest, setForest] = useState<OperationForest | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useLiveEffect((live) => {
    let snapshotLoaded = false;
    let pending: OperationEvent[] = [];
    const apply = (event: OperationEvent) => setForest((current) => operationForest(current ?? EMPTY_FOREST, event));
    const installSnapshot = (snapshot: OperationForest | null) => {
      if (!live()) return;
      snapshotLoaded = true;
      setForest(pending.reduce(operationForest, snapshot ?? EMPTY_FOREST));
    };
    const load = () => {
      snapshotLoaded = false;
      pending = [];
      fetch('/api/operations')
        .then((response) => (response.ok ? response.json() : null))
        .then((snapshot: OperationForest | null) => installSnapshot(snapshot))
        .catch(() => installSnapshot(null));
    };
    const unsubscribe = subscribe((message) => {
      if (message.type !== 'operations') return;
      if (snapshotLoaded) apply(message.event);
      else pending.push(message.event);
    }, load);
    load();
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, []);

  if (forest === null) return createElement('p', { className: 'text-small text-muted' }, 'Loading operations…');
  const visibleForest = visibleOperationForest(forest);
  if (visibleForest.operations.length === 0 && visibleForest.recent.length === 0) {
    return createElement('p', { className: 'text-small text-muted' }, 'No live or recently completed operations.');
  }
  return createElement('div', { className: 'grid gap-4' },
    createElement('div', { className: card },
      createElement('h3', { className: `${labelType} border-b border-hairline px-4 py-2.5 text-muted` }, 'Live operations'),
      visibleForest.operations.length === 0
        ? createElement('p', { className: 'px-4 py-3 text-small text-muted' }, 'No operations running.')
        : createElement('ul', { 'aria-label': 'Live operation tree', className: 'px-4' }, visibleForest.operations.map((operation) =>
          createElement(OperationRow, { key: operation.spanId, operation, now, depth: 0 }),
        )),
    ),
    createElement('div', { className: card },
      createElement('h3', { className: `${labelType} border-b border-hairline px-4 py-2.5 text-muted` }, 'Recently completed'),
      visibleForest.recent.length === 0
        ? createElement('p', { className: 'px-4 py-3 text-small text-muted' }, 'No completed operations yet.')
        : createElement('ul', { 'aria-label': 'Recently completed operations', className: 'px-4' }, visibleForest.recent.map((operation) =>
          createElement(OperationRow, { key: operation.spanId, operation, now, depth: 0 }),
        )),
    ),
  );
}

/**
 * Operations hosts independent scheduler and telemetry sections; the telemetry
 * section owns its snapshot-plus-firehose read model.
 */
export function OperationsPage({ scheduledJobs, spanTree, flaggedWorktrees }: OperationsPageProps) {
  return createElement(
    'div',
    null,
    createElement('h1', { className: `${displayTitle} mb-5` }, 'Operations'),
    createElement(
      'div',
      { className: 'grid gap-4' },
      createElement(
        'section',
        { 'aria-labelledby': 'scheduled-jobs-heading' },
        createElement('h2', { id: 'scheduled-jobs-heading', className: sectionTitle }, 'Scheduled jobs'),
        scheduledJobs ?? createElement(ScheduledJobsView),
      ),
      createElement(
        'section',
        { 'aria-labelledby': 'flagged-worktrees-heading' },
        createElement('h2', { id: 'flagged-worktrees-heading', className: sectionTitle }, 'Flagged worktrees'),
        flaggedWorktrees ?? createElement(FlaggedWorktreesView),
      ),
      createElement(
        'section',
        { 'aria-labelledby': 'span-tree-heading' },
        createElement('h2', { id: 'span-tree-heading', className: sectionTitle }, 'Live spans'),
        spanTree ?? createElement(OperationsReadout),
      ),
    ),
  );
}
