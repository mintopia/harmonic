import { createElement, useCallback, useState } from 'react';
import { api } from '../api.js';
import { mergeWorktrees, type WorktreeInventoryEntry, type WorktreeState } from '../worktree-inventory-model.js';
import { subscribe } from '../ws.js';
import { btnGhost, btnPrimary, btnQuiet, btnQuietDestructive, card, chip, panelTitle, tableHead } from '../ui.js';
import { useLiveEffect } from '../useLiveEffect.js';
import { Modal } from './Modal.js';

const GRID = 'grid grid-cols-[7rem_minmax(11rem,1.2fr)_minmax(13rem,1.7fr)_7rem_8rem_5rem_minmax(11rem,auto)] gap-x-4 px-4';
const MIN_W = 'min-w-[72rem]';
const PAGE_SIZE = 100;
const STATE_STYLE: Record<WorktreeState, string> = {
  Active: 'bg-ready-tint text-ready', Stale: 'bg-merged-tint text-merged', Dirty: 'bg-running-tint text-running',
  Unreadable: 'bg-fail-tint text-fail', Orphan: 'bg-blocked-tint text-blocked', Missing: 'bg-raised text-muted',
};

export function sizeLabel(sizeBytes: number | null): string {
  if (sizeBytes === null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = sizeBytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function worktreeName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function subjectLabel(worktree: WorktreeInventoryEntry): string {
  if (!worktree.subject) return 'Unassigned';
  return worktree.subject.kind === 'task' ? `Task ${worktree.subject.taskId}: ${worktree.subject.title}` : `Epic #${worktree.subject.epicRef}: ${worktree.subject.title}`;
}

function changesCell(worktree: WorktreeInventoryEntry) {
  if (worktree.state === 'Missing') return createElement('span', { className: 'text-small text-running' }, 'recreating');
  if (worktree.changeCount !== null && worktree.changeCount > 0) return createElement('span', { className: 'text-small text-fail' }, `${worktree.changeCount} uncommitted`);
  if (worktree.changeCount === 0) return createElement('span', { className: 'text-small text-muted' }, 'Clean');
  return createElement('span', { className: 'text-small text-faint' }, '—');
}

function WorktreeRow({ worktree, busy, onOpenTask, onOpenEpic, onClean, onForceCleanup }: {
  worktree: WorktreeInventoryEntry; busy: boolean; onOpenTask?: (taskId: number) => void; onOpenEpic?: (epicRef: number) => void;
  onClean: (worktree: WorktreeInventoryEntry) => void; onForceCleanup: (worktree: WorktreeInventoryEntry) => void;
}) {
  const subject = worktree.subject;
  const open = subject?.kind === 'task' ? () => onOpenTask?.(subject.taskId) : subject?.kind === 'epic' ? () => onOpenEpic?.(subject.epicRef) : undefined;
  const cleanable = worktree.state === 'Stale' || worktree.state === 'Orphan';
  return createElement('div', { role: 'row', className: `${GRID} ${MIN_W} items-center border-t border-hairline py-3` },
    createElement('div', { role: 'cell', className: 'min-w-0 truncate font-data text-small text-ink', title: worktree.path }, worktreeName(worktree.path)),
    createElement('div', { role: 'cell', className: 'min-w-0 truncate font-data text-small text-tool', title: worktree.branch ?? undefined }, worktree.branch ?? 'Detached'),
    createElement('div', { role: 'cell', className: 'min-w-0 truncate text-small text-muted', title: subjectLabel(worktree) }, subjectLabel(worktree)),
    createElement('div', { role: 'cell' }, createElement('span', { className: `${chip} ${STATE_STYLE[worktree.state]}` }, worktree.state)),
    createElement('div', { role: 'cell', className: 'min-w-0 truncate' }, changesCell(worktree)),
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
    createElement('div', { 'aria-hidden': true, className: `${MIN_W} flex items-center justify-between gap-3 border-b border-hairline px-4 py-3` },
      createElement('span', { className: tableHead }, 'Worktree inventory'),
      createElement('span', { className: 'font-data text-small text-faint' }, 'git worktree list ⋈ database'),
    ),
    createElement('div', { role: 'rowgroup' }, createElement('div', { role: 'row', className: `${GRID} ${MIN_W} py-2.5 ${tableHead}` }, ...['Worktree', 'Branch', 'Subject', 'State', 'Changes', 'Size', 'Actions'].map((label) => createElement('span', { key: label, role: 'columnheader' }, label)))),
    createElement('div', { role: 'rowgroup', className: MIN_W }, worktrees.map((worktree) => createElement(WorktreeRow, { key: worktree.id, worktree, busy: busyId === worktree.id, onOpenTask, onOpenEpic, onClean, onForceCleanup }))),
  );
}

export function CleanupDialog({ worktree, files, error, busy, onClose, onConfirm }: {
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

export interface WorktreeInventory {
  worktrees: WorktreeInventoryEntry[] | null;
  reconciledAt: number | null;
  busyId: string | null;
  reconciling: boolean;
  error: string | null;
  confirmation: { worktree: WorktreeInventoryEntry; files: string[] | null } | null;
  clean: (worktree: WorktreeInventoryEntry) => Promise<void>;
  forceCleanup: (worktree: WorktreeInventoryEntry) => Promise<void>;
  reconcile: () => Promise<void>;
  confirmCleanup: () => Promise<void>;
  dismissConfirmation: () => void;
}

export function useWorktreeInventory(): WorktreeInventory {
  const [worktrees, setWorktrees] = useState<WorktreeInventoryEntry[] | null>(null);
  const [reconciledAt, setReconciledAt] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ worktree: WorktreeInventoryEntry; files: string[] | null } | null>(null);
  const load = useCallback(async () => {
    const all: WorktreeInventoryEntry[] = [];
    let reconciled: number | null = null;
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await api.worktrees({ limit: PAGE_SIZE, offset });
      all.push(...page.worktrees);
      reconciled = page.reconciledAt;
      if (page.worktrees.length === 0 || all.length >= page.total) return { worktrees: all, reconciledAt: reconciled };
    }
  }, []);
  const apply = useCallback(async () => { const snapshot = await load(); setWorktrees(snapshot.worktrees); setReconciledAt(snapshot.reconciledAt); }, [load]);
  useLiveEffect((live) => {
    let snapshotLoaded = false;
    let pending: WorktreeInventoryEntry[][] = [];
    const install = (snapshot: { worktrees: WorktreeInventoryEntry[]; reconciledAt: number | null }) => { if (live()) { snapshotLoaded = true; setWorktrees(pending.reduce(mergeWorktrees, snapshot.worktrees)); setReconciledAt(snapshot.reconciledAt); } };
    const refresh = () => { snapshotLoaded = false; pending = []; load().then(install).catch(() => install({ worktrees: [], reconciledAt: null })); };
    const unsubscribe = subscribe((message) => { if (message.type === 'worktrees') { if (snapshotLoaded) setWorktrees((current) => mergeWorktrees(current ?? [], message.worktrees)); else pending.push(message.worktrees); } }, refresh);
    refresh();
    return unsubscribe;
  }, [load]);
  const clean = async (worktree: WorktreeInventoryEntry) => {
    setBusyId(worktree.id); setError(null);
    try { await api.cleanupWorktree(worktree.id); await apply(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusyId(null); }
  };
  const forceCleanup = async (worktree: WorktreeInventoryEntry) => {
    setBusyId(worktree.id); setError(null);
    try { const { files } = await api.dirtyWorktreeFiles(worktree.id); setConfirmation({ worktree, files }); } catch (reason) { setConfirmation({ worktree, files: null }); setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusyId(null); }
  };
  const reconcile = async () => {
    setReconciling(true); setError(null);
    try { await api.reconcileWorktrees(); await apply(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setReconciling(false); }
  };
  const confirmCleanup = async () => {
    if (!confirmation) return;
    await clean(confirmation.worktree);
    setConfirmation(null);
  };
  const dismissConfirmation = () => { setConfirmation(null); setError(null); };
  return { worktrees, reconciledAt, busyId, reconciling, error, confirmation, clean, forceCleanup, reconcile, confirmCleanup, dismissConfirmation };
}
