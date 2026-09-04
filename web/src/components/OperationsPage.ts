import { createElement, useState, type ReactNode } from 'react';
import { operationForest, visibleOperationForest, type Operation, type OperationForest } from '../operations-model.js';
import type { WorktreeInventoryEntry } from '../worktree-inventory-model.js';
import { btnPrimary, card, displayTitle, labelType } from '../ui.js';
import { subscribe, type OperationEvent } from '../ws.js';
import { ScheduledJobsView } from './ScheduledJobsView.js';
import { CleanupDialog, sizeLabel, useWorktreeInventory, WorktreesTable } from './WorktreeInventoryView.js';
import { useLiveEffect } from '../useLiveEffect.js';
import type { Task } from '../types.js';
import type { Epic } from '../epic-model.js';

export interface OperationsPageProps {
  scheduledJobs?: ReactNode;
  spanTree?: ReactNode;
  tasks?: readonly Task[];
  epics?: readonly Epic[];
  onOpenTask?: (taskId: number) => void;
  onOpenEpic?: (epicRef: number) => void;
}

const ATTENTION_STATES = new Set(['Dirty', 'Unreadable', 'Orphan']);

function reconciledLabel(reconciledAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - reconciledAt) / 1_000));
  if (seconds < 60) return 'reconciled just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `reconciled ${minutes}m ago`;
  return `reconciled ${Math.floor(minutes / 60)}h ago`;
}

function WorktreeSummary({ worktrees, reconciledAt }: { worktrees: readonly WorktreeInventoryEntry[] | null; reconciledAt: number | null }) {
  if (worktrees === null) return null;
  const total = worktrees.length;
  const attention = worktrees.filter((worktree) => ATTENTION_STATES.has(worktree.state)).length;
  const stale = worktrees.filter((worktree) => worktree.state === 'Stale').length;
  const totalBytes = worktrees.reduce((sum, worktree) => sum + (worktree.sizeBytes ?? 0), 0);
  const dot = createElement('span', { 'aria-hidden': true, className: 'text-faint' }, '·');
  const parts: ReactNode[] = [createElement('span', { key: 'total' }, `${total} ${total === 1 ? 'worktree' : 'worktrees'} on disk`)];
  if (attention > 0) parts.push(dot, createElement('span', { key: 'attn', className: 'text-running' }, `${attention} need attention`));
  if (stale > 0) parts.push(dot, createElement('span', { key: 'stale', className: 'text-merged' }, `${stale} stale`));
  parts.push(dot, createElement('span', { key: 'size' }, sizeLabel(totalBytes)));
  if (reconciledAt !== null) parts.push(dot, createElement('span', { key: 'reconciled' }, reconciledLabel(reconciledAt)));
  return createElement('div', { className: 'flex flex-wrap items-center gap-x-2.5 gap-y-1 text-small text-muted' }, ...parts);
}

const EMPTY_FOREST: OperationForest = { operations: [], recent: [] };

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

interface OperationSubject {
  kind: 'task' | 'epic';
  id: number;
  title: string;
}

type OperationTask = Pick<Task, 'id' | 'summary'>;
type OperationEpic = Pick<Epic, 'ref' | 'title'>;

function subject(operation: Operation, tasks: readonly OperationTask[], epics: readonly OperationEpic[]): OperationSubject | null {
  const taskId = operation.attributes['task.id'];
  if (typeof taskId === 'number') {
    const title = operation.attributes['task.title'];
    return { kind: 'task', id: taskId, title: typeof title === 'string' ? title : tasks.find((task) => task.id === taskId)?.summary ?? `Task ${taskId}` };
  }
  const epicRef = operation.attributes['epic.ref'];
  if (typeof epicRef === 'number') {
    const title = operation.attributes['epic.title'];
    return { kind: 'epic', id: epicRef, title: typeof title === 'string' ? title : epics.find((epic) => epic.ref === epicRef)?.title ?? `Epic #${epicRef}` };
  }
  return null;
}

const OPERATION_DESCRIPTIONS: Record<string, string> = {
  attempt: 'Working on this Task',
  epic: 'Coordinating this Epic',
  'epic.cut': 'Preparing the Epic branch',
  'epic.member-merge': 'Merging an Epic Task',
  'epic.git.rebase': 'Rebasing the Epic',
  'epic.git.fast-forward': 'Fast-forwarding the Epic',
  'epic.heal': 'Repairing the Epic',
  'epic.verify': 'Verifying the Epic',
  'epic.integrate': 'Integrating the Epic',
  'epic.merge': 'Merging the Epic',
  'epic.retire': 'Finishing the Epic',
};

function description(operation: Operation): string {
  return OPERATION_DESCRIPTIONS[operation.type] ?? `Running ${operation.type.replace(/[._-]/g, ' ')}`;
}

function status(operation: Operation): string {
  if (operation.endedAt === null) return 'Running';
  return operation.status.code === 2 ? 'Failed' : 'Completed';
}

export function OperationRow({
  operation,
  now,
  depth,
  tasks = [],
  epics = [],
  onOpenTask,
  onOpenEpic,
  owner,
}: {
  operation: Operation;
  now: number;
  depth: number;
  tasks?: readonly OperationTask[];
  epics?: readonly OperationEpic[];
  onOpenTask?: (taskId: number) => void;
  onOpenEpic?: (epicRef: number) => void;
  owner?: OperationSubject | null;
}): ReactNode {
  const duration = (operation.endedAt ?? now) - operation.startedAt;
  const operationSubject = subject(operation, tasks, epics) ?? owner ?? null;
  return createElement(
    'li',
    {
      id: `operation-${operation.spanId}`,
      className: 'border-t border-hairline py-2.5 first:border-t-0',
      style: { paddingLeft: `${depth * 1.25}rem` },
    },
    createElement('div', { className: 'flex flex-wrap items-baseline gap-x-3 gap-y-1' },
      createElement('span', { className: 'font-medium text-ink' }, operation.type),
      operationSubject && createElement(
        'button',
        {
          type: 'button',
          className: 'text-small text-accent hover:underline',
          onClick: operationSubject.kind === 'task'
            ? () => onOpenTask?.(operationSubject.id)
            : () => onOpenEpic?.(operationSubject.id),
        },
        operationSubject.title,
      ),
      createElement('span', { className: 'text-small text-muted' }, description(operation)),
      createElement('span', { className: `${labelType} ${operation.endedAt === null ? 'text-running' : operation.status.code === 2 ? 'text-fail' : 'text-muted'}` }, status(operation)),
      createElement('span', { className: 'ml-auto text-small tabular-nums text-muted' }, elapsed(duration)),
    ),
    operation.children.length > 0 && createElement('ul', { className: 'mt-1' }, operation.children.map((child) =>
      createElement(OperationRow, { key: child.spanId, operation: child, now, depth: depth + 1, tasks, epics, onOpenTask, onOpenEpic, owner: operationSubject }),
    )),
  );
}

function OperationsReadout({ tasks, epics, onOpenTask, onOpenEpic }: Pick<OperationsPageProps, 'tasks' | 'epics' | 'onOpenTask' | 'onOpenEpic'>) {
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
          createElement(OperationRow, { key: operation.spanId, operation, now, depth: 0, tasks, epics, onOpenTask, onOpenEpic }),
        )),
    ),
    createElement('div', { className: card },
      createElement('h3', { className: `${labelType} border-b border-hairline px-4 py-2.5 text-muted` }, 'Recently completed'),
      visibleForest.recent.length === 0
        ? createElement('p', { className: 'px-4 py-3 text-small text-muted' }, 'No completed operations yet.')
        : createElement('ul', { 'aria-label': 'Recently completed operations', className: 'px-4' }, visibleForest.recent.map((operation) =>
          createElement(OperationRow, { key: operation.spanId, operation, now, depth: 0, tasks, epics, onOpenTask, onOpenEpic }),
        )),
    ),
  );
}

/**
 * Operations leads with the worktree inventory — the operator's disposal
 * surface — then pairs the live-span readout with the scheduler strip. The
 * inventory read model (snapshot plus firehose) is lifted to the page so the
 * header can total it and own the reconcile action.
 */
export function OperationsPage({ scheduledJobs, spanTree, tasks, epics, onOpenTask, onOpenEpic }: OperationsPageProps) {
  const inventory = useWorktreeInventory();
  const { worktrees, reconciledAt, busyId, reconciling, error, confirmation } = inventory;
  return createElement(
    'div',
    { className: 'grid gap-6' },
    createElement(
      'header',
      { className: 'flex flex-wrap items-end justify-between gap-4' },
      createElement('div', { className: 'grid gap-1.5' },
        createElement('h1', { className: displayTitle }, 'Operations'),
        createElement(WorktreeSummary, { worktrees, reconciledAt }),
      ),
      createElement('button', { type: 'button', className: btnPrimary, disabled: reconciling, onClick: inventory.reconcile }, reconciling ? 'Reconciling…' : 'Reconcile now'),
    ),
    error && createElement('p', { role: 'alert', className: 'text-small text-fail' }, error),
    createElement(
      'section',
      { 'aria-labelledby': 'worktrees-heading', className: 'grid gap-3' },
      createElement('h2', { id: 'worktrees-heading', className: 'sr-only' }, 'Worktrees'),
      worktrees === null
        ? createElement('p', { className: 'text-small text-muted' }, 'Loading worktrees…')
        : worktrees.length === 0
          ? createElement('p', { className: 'text-small text-muted' }, 'No worktrees found.')
          : createElement(WorktreesTable, { worktrees, busyId, onOpenTask, onOpenEpic, onClean: inventory.clean, onForceCleanup: inventory.forceCleanup }),
    ),
    createElement(
      'div',
      { className: 'grid gap-6' },
      createElement(
        'section',
        { 'aria-labelledby': 'span-tree-heading', className: 'grid gap-3' },
        createElement('h2', { id: 'span-tree-heading', className: 'sr-only' }, 'Live operations'),
        spanTree ?? createElement(OperationsReadout, { tasks, epics, onOpenTask, onOpenEpic }),
      ),
      createElement(
        'section',
        { 'aria-labelledby': 'scheduled-jobs-heading', className: 'grid gap-3' },
        createElement('h2', { id: 'scheduled-jobs-heading', className: 'sr-only' }, 'Scheduled jobs'),
        scheduledJobs ?? createElement(ScheduledJobsView),
      ),
    ),
    confirmation && createElement(CleanupDialog, {
      worktree: confirmation.worktree, files: confirmation.files, error, busy: busyId === confirmation.worktree.id,
      onClose: inventory.dismissConfirmation, onConfirm: inventory.confirmCleanup,
    }),
  );
}
