import { createElement, useCallback, useState } from 'react';
import { api } from '../api.js';
import { mergeWorktrees, type WorktreeInventoryEntry, type WorktreeState } from '../flagged-worktrees-model.js';
import { subscribe } from '../ws.js';
import { btnGhost, btnPrimary, btnQuiet, btnQuietDestructive, card, chip, panelTitle, tableHead } from '../ui.js';
import { useLiveEffect } from '../useLiveEffect.js';
import { Modal } from './Modal.js';

const GRID = 'grid grid-cols-[7rem_minmax(12rem,1fr)_minmax(14rem,2fr)_6rem_minmax(19rem,auto)] gap-x-4 px-4';
const PAGE_SIZE = 100;
const STATE_STYLE: Record<WorktreeState, string> = {
  Active: 'bg-ready-tint text-ready', Stale: 'bg-running-tint text-running', Dirty: 'bg-fail-tint text-fail',
  Unreadable: 'bg-fail-tint text-fail', Orphan: 'bg-blocked-tint text-blocked', Missing: 'bg-raised text-muted',
};

function sizeLabel(sizeBytes: number | null): string {
  if (sizeBytes === null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = sizeBytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function subjectLabel(worktree: WorktreeInventoryEntry): string {
  if (!worktree.subject) return 'Unassigned';
  return worktree.subject.kind === 'task' ? `Task ${worktree.subject.taskId}: ${worktree.subject.title}` : `Epic #${worktree.subject.epicRef}: ${worktree.subject.title}`;
}

function WorktreeRow({ worktree, busy, onOpenTask, onOpenEpic, onClean, onForceCleanup }: {
  worktree: WorktreeInventoryEntry; busy: boolean; onOpenTask?: (taskId: number) => void; onOpenEpic?: (epicRef: number) => void;
  onClean: (worktree: WorktreeInventoryEntry) => void; onForceCleanup: (worktree: WorktreeInventoryEntry) => void;
}) {
  const subject = worktree.subject;
  const open = subject?.kind === 'task' ? () => onOpenTask?.(subject.taskId) : subject?.kind === 'epic' ? () => onOpenEpic?.(subject.epicRef) : undefined;
  const cleanable = worktree.state === 'Stale' || worktree.state === 'Orphan';
  return createElement('div', { role: 'row', className: `${GRID} min-w-[64rem] items-center border-t border-hairline py-3` },
    createElement('div', { role: 'cell' }, createElement('span', { className: `${chip} ${STATE_STYLE[worktree.state]}` }, worktree.state)),
    createElement('div', { role: 'cell', className: 'min-w-0 truncate font-data text-small text-tool', title: worktree.branch ?? undefined }, worktree.branch ?? 'Detached'),
    createElement('div', { role: 'cell', className: 'min-w-0 truncate text-small text-muted', title: worktree.path }, subjectLabel(worktree)),
    createElement('div', { role: 'cell', className: 'tabular-nums text-small text-muted' }, sizeLabel(worktree.sizeBytes)),
    createElement('div', { role: 'cell', className: 'flex flex-wrap justify-end gap-x-3 gap-y-1' },
      open && createElement('button', { type: 'button', className: btnQuiet, onClick: open }, 'Open'),
      cleanable && createElement('button', { type: 'button', className: btnQuiet, disabled: busy, onClick: () => onClean(worktree) }, busy ? 'Cleaning…' : 'Clean now'),
      worktree.state === 'Dirty' && createElement('button', { type: 'button', className: btnQuietDestructive, disabled: busy, onClick: () => onForceCleanup(worktree) }, 'Force cleanup'),
    ),
  );
}

export function WorktreesTable({ worktrees, busyId, onOpenTask, onOpenEpic, onClean, onForceCleanup }: {
  worktrees: WorktreeInventoryEntry[]; busyId: string | null; onOpenTask?: (taskId: number) => void; onOpenEpic?: (epicRef: number) => void;
  onClean: (worktree: WorktreeInventoryEntry) => void; onForceCleanup: (worktree: WorktreeInventoryEntry) => void;
}) {
  return createElement('div', { role: 'table', 'aria-label': 'Worktrees', className: `${card} overflow-x-auto` },
    createElement('div', { role: 'rowgroup' }, createElement('div', { role: 'row', className: `${GRID} min-w-[64rem] py-2.5 ${tableHead}` }, ...['State', 'Branch', 'Subject', 'Size', 'Actions'].map((label) => createElement('span', { key: label, role: 'columnheader' }, label)))),
    createElement('div', { role: 'rowgroup', className: 'min-w-[64rem]' }, worktrees.map((worktree) => createElement(WorktreeRow, { key: worktree.id, worktree, busy: busyId === worktree.id, onOpenTask, onOpenEpic, onClean, onForceCleanup }))),
  );
}

function CleanupDialog({ worktree, files, error, busy, onClose, onConfirm }: {
  worktree: WorktreeInventoryEntry; files: string[] | null; error: string | null; busy: boolean; onClose: () => void; onConfirm: () => void;
}) {
  const content = createElement('div', { className: 'p-5' },
    createElement('h2', { className: `${panelTitle} pr-8` }, 'Force cleanup dirty worktree'),
    createElement('p', { className: 'mt-3 text-small text-muted' }, 'This removes ', createElement('span', { className: 'font-data text-ink' }, worktree.branch ?? worktree.path), ' and discards its uncommitted files.'),
    files && createElement('ul', { className: 'mt-4 max-h-56 overflow-auto rounded-md bg-sunken p-3 font-data text-small text-ink' }, files.map((file) => createElement('li', { key: file }, file))),
    error && createElement('p', { role: 'alert', className: 'mt-3 text-small text-fail' }, error),
    createElement('div', { className: 'mt-5 flex justify-end gap-3' },
      createElement('button', { type: 'button', className: btnGhost, disabled: busy, onClick: onClose }, 'Cancel'),
      createElement('button', { type: 'button', className: btnPrimary, disabled: busy || files === null, onClick: onConfirm }, busy ? 'Cleaning…' : 'Force cleanup'),
    ),
  );
  return createElement(Modal, { label: 'Force cleanup dirty worktree', onClose }, content);
}

export function FlaggedWorktreesView({ onOpenTask, onOpenEpic }: { onOpenTask?: (taskId: number) => void; onOpenEpic?: (epicRef: number) => void }) {
  const [worktrees, setWorktrees] = useState<WorktreeInventoryEntry[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ worktree: WorktreeInventoryEntry; files: string[] | null } | null>(null);
  const load = useCallback(async () => {
    const all: WorktreeInventoryEntry[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await api.worktrees({ limit: PAGE_SIZE, offset });
      all.push(...page.worktrees);
      if (page.worktrees.length === 0 || all.length >= page.total) return all;
    }
  }, []);
  useLiveEffect((live) => {
    let snapshotLoaded = false;
    let pending: WorktreeInventoryEntry[][] = [];
    const install = (snapshot: WorktreeInventoryEntry[]) => { if (live()) { snapshotLoaded = true; setWorktrees(pending.reduce(mergeWorktrees, snapshot)); } };
    const refresh = () => { snapshotLoaded = false; pending = []; load().then(install).catch(() => install([])); };
    const unsubscribe = subscribe((message) => { if (message.type === 'worktrees') { if (snapshotLoaded) setWorktrees((current) => mergeWorktrees(current ?? [], message.worktrees)); else pending.push(message.worktrees); } }, refresh);
    refresh();
    return unsubscribe;
  }, [load]);
  const clean = async (worktree: WorktreeInventoryEntry) => {
    setBusyId(worktree.id); setError(null);
    try { await api.cleanupWorktree(worktree.id); setWorktrees(await load()); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusyId(null); }
  };
  const forceCleanup = async (worktree: WorktreeInventoryEntry) => {
    setBusyId(worktree.id); setError(null);
    try { const { files } = await api.dirtyWorktreeFiles(worktree.id); setConfirmation({ worktree, files }); } catch (reason) { setConfirmation({ worktree, files: null }); setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusyId(null); }
  };
  const reconcile = async () => {
    setReconciling(true); setError(null);
    try { await api.reconcileWorktrees(); setWorktrees(await load()); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setReconciling(false); }
  };
  return createElement('div', { className: 'grid gap-3' },
    createElement('div', { className: 'flex items-center justify-end' }, createElement('button', { type: 'button', className: btnGhost, disabled: reconciling, onClick: reconcile }, reconciling ? 'Reconciling…' : 'Reconcile now')),
    error && createElement('p', { role: 'alert', className: 'text-small text-fail' }, error),
    worktrees === null ? createElement('p', { className: 'text-small text-muted' }, 'Loading worktrees...') : worktrees.length === 0 ? createElement('p', { className: 'text-small text-muted' }, 'No worktrees found.') : createElement(WorktreesTable, { worktrees, busyId, onOpenTask, onOpenEpic, onClean: clean, onForceCleanup: forceCleanup }),
    confirmation && createElement(CleanupDialog, { worktree: confirmation.worktree, files: confirmation.files, error, busy: busyId === confirmation.worktree.id, onClose: () => { setConfirmation(null); setError(null); }, onConfirm: async () => { await clean(confirmation.worktree); setConfirmation(null); } }),
  );
}
