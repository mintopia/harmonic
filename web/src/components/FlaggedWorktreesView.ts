import { createElement, useState } from 'react';
import { isWorktreesSnapshot, mergeWorktrees, type WorktreeInventoryEntry } from '../flagged-worktrees-model.js';
import { subscribe } from '../ws.js';
import { card, chip, tableHead } from '../ui.js';
import { useLiveEffect } from '../useLiveEffect.js';

const GRID = 'grid grid-cols-[minmax(14rem,2fr)_7rem_5rem_minmax(9rem,1fr)_5rem_5rem_7rem] gap-x-4 px-4';

function sizeLabel(sizeBytes: number | null): string {
  if (sizeBytes === null) return '—';
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  return `${(sizeBytes / 1024).toFixed(1)} KB`;
}

function WorktreeRow({ worktree }: { worktree: WorktreeInventoryEntry }) {
  return createElement('div', { role: 'row', className: `${GRID} items-center border-t border-hairline py-3` },
    createElement('div', { role: 'cell', className: 'min-w-0 truncate font-medium text-ink', title: worktree.path }, worktree.path),
    createElement('div', { role: 'cell', className: 'min-w-0 truncate text-small text-muted', title: worktree.branch ?? undefined }, worktree.branch ?? '—'),
    createElement('div', { role: 'cell', className: 'tabular-nums text-small text-muted' }, worktree.workspaceId),
    createElement('div', { role: 'cell', className: 'min-w-0 truncate text-small text-muted' }, worktree.subject?.title ?? 'Unassigned'),
    createElement('div', { role: 'cell', className: 'tabular-nums text-small text-muted' }, sizeLabel(worktree.sizeBytes)),
    createElement('div', { role: 'cell', className: 'text-small text-muted' }, worktree.dirty === null ? '—' : worktree.dirty ? 'Yes' : 'No'),
    createElement('div', { role: 'cell' }, createElement('span', { className: `${chip} bg-raised text-muted` }, worktree.state)));
}

export function WorktreesTable({ worktrees }: { worktrees: WorktreeInventoryEntry[] }) {
  return createElement('div', { role: 'table', 'aria-label': 'Worktrees', className: `${card} overflow-x-auto` },
    createElement('div', { role: 'rowgroup' }, createElement('div', { role: 'row', className: `${GRID} min-w-[55rem] py-2.5 ${tableHead}` }, ...['Path', 'Branch', 'Workspace', 'Subject', 'Size', 'Dirty', 'State'].map((label) => createElement('span', { key: label, role: 'columnheader' }, label)))),
    createElement('div', { role: 'rowgroup', className: 'min-w-[55rem]' }, worktrees.map((worktree) => createElement(WorktreeRow, { key: `${worktree.workspaceId}:${worktree.path}`, worktree }))));
}

export function FlaggedWorktreesView() {
  const [worktrees, setWorktrees] = useState<WorktreeInventoryEntry[] | null>(null);
  useLiveEffect((live) => {
    let snapshotLoaded = false;
    let pending: WorktreeInventoryEntry[][] = [];
    const apply = (next: WorktreeInventoryEntry[]) => setWorktrees((current) => mergeWorktrees(current ?? [], next));
    const install = (snapshot: WorktreeInventoryEntry[]) => {
      if (!live()) return;
      snapshotLoaded = true;
      setWorktrees(pending.reduce(mergeWorktrees, snapshot));
    };
    const load = () => {
      snapshotLoaded = false;
      pending = [];
      fetch('/api/worktrees').then((response) => response.ok ? response.json() : { worktrees: [] })
        .then((snapshot: unknown) => install(isWorktreesSnapshot(snapshot) ? snapshot.worktrees : []))
        .catch(() => install([]));
    };
    const unsubscribe = subscribe((message) => {
      if (message.type !== 'worktrees') return;
      if (snapshotLoaded) apply(message.worktrees);
      else pending.push(message.worktrees);
    }, load);
    load();
    return unsubscribe;
  }, []);
  if (worktrees === null) return createElement('p', { className: 'text-small text-muted' }, 'Loading worktrees...');
  if (worktrees.length === 0) return createElement('p', { className: 'text-small text-muted' }, 'No worktrees found.');
  return createElement(WorktreesTable, { worktrees });
}
