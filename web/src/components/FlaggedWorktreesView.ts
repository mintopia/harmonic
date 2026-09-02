import { createElement, useState } from 'react';
import {
  flaggedWorktreeReasonLabel,
  isFlaggedWorktreesSnapshot,
  mergeFlaggedWorktrees,
  type FlaggedWorktree,
} from '../flagged-worktrees-model.js';
import { subscribe } from '../ws.js';
import { card, chip, tableHead } from '../ui.js';
import { useLiveEffect } from '../useLiveEffect.js';

const GRID = 'grid grid-cols-[minmax(14rem,2fr)_5rem_5rem_7rem] gap-x-4 px-4';

function FlaggedWorktreeRow({ worktree }: { worktree: FlaggedWorktree }) {
  return createElement(
    'div',
    { role: 'row', className: `${GRID} items-center border-t border-hairline py-3` },
    createElement('div', { role: 'cell', className: 'min-w-0 truncate font-medium text-ink', title: worktree.path }, worktree.path),
    createElement('div', { role: 'cell', className: 'tabular-nums text-small text-muted' }, worktree.workspaceId),
    createElement('div', { role: 'cell', className: 'tabular-nums text-small text-muted' }, worktree.taskId ?? '—'),
    createElement('div', { role: 'cell' }, createElement('span', { className: `${chip} bg-raised text-muted` }, flaggedWorktreeReasonLabel(worktree.reason))),
  );
}

/** A read-only snapshot plus firehose view of worktrees the reconciler
 * is holding for operator disposition — surfacing only; disposing of one is a
 * manual, out-of-band action. */
export function FlaggedWorktreesTable({ worktrees }: { worktrees: FlaggedWorktree[] }) {
  return createElement(
    'div',
    { role: 'table', 'aria-label': 'Flagged worktrees', className: `${card} overflow-x-auto` },
    createElement(
      'div',
      { role: 'rowgroup' },
      createElement(
        'div',
        { role: 'row', className: `${GRID} min-w-[40rem] py-2.5 ${tableHead}` },
        ...['Path', 'Workspace', 'Task', 'Reason'].map((label) =>
          createElement('span', { key: label, role: 'columnheader' }, label),
        ),
      ),
    ),
    createElement('div', { role: 'rowgroup', className: 'min-w-[40rem]' }, worktrees.map((worktree) =>
      createElement(FlaggedWorktreeRow, { key: worktree.path, worktree }),
    )),
  );
}

export function FlaggedWorktreesView() {
  const [worktrees, setWorktrees] = useState<FlaggedWorktree[] | null>(null);

  useLiveEffect((live) => {
    let snapshotLoaded = false;
    let pending: FlaggedWorktree[][] = [];
    const apply = (next: FlaggedWorktree[]) => setWorktrees((current) => mergeFlaggedWorktrees(current ?? [], next));
    const installSnapshot = (snapshot: FlaggedWorktree[]) => {
      if (!live()) return;
      snapshotLoaded = true;
      setWorktrees(pending.reduce(mergeFlaggedWorktrees, snapshot));
    };
    const load = () => {
      snapshotLoaded = false;
      pending = [];
      fetch('/api/flagged-worktrees')
        .then((response) => (response.ok ? response.json() : { worktrees: [] }))
        .then((snapshot: unknown) => installSnapshot(isFlaggedWorktreesSnapshot(snapshot) ? snapshot.worktrees : []))
        .catch(() => installSnapshot([]));
    };
    const unsubscribe = subscribe((message) => {
      if (message.type !== 'flagged-worktrees') return;
      if (snapshotLoaded) apply(message.flags);
      else pending.push(message.flags);
    }, load);
    load();
    return () => {
      unsubscribe();
    };
  }, []);

  if (worktrees === null) return createElement('p', { className: 'text-small text-muted' }, 'Loading flagged worktrees…');
  if (worktrees.length === 0) return createElement('p', { className: 'text-small text-muted' }, 'No worktrees awaiting disposition.');
  return createElement(FlaggedWorktreesTable, { worktrees });
}
