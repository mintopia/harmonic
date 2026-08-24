import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import type { Workspace } from '../types';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { DirectoryPicker } from './DirectoryPicker';
import { btnGhost, btnPrimary, field, labelType, panelTitle } from '../ui';

export function NewWorkspaceForm({ onClose, onCreated }: { onClose: () => void; onCreated: (w: Workspace) => void }) {
  const [name, setName] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const workspace = await api.createWorkspace({ name, workingDir });
      onCreated(workspace);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal label="New workspace" onClose={onClose} className="max-w-md">
      <form onSubmit={submit} className="p-5">
        <h2 className={`${panelTitle} mb-4`}>New workspace</h2>

        <div className="mb-3">
          <label className={`mb-1 block ${labelType} text-muted`} htmlFor="workspace-name">
            Name
          </label>
          <input
            id="workspace-name"
            className={field}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            required
          />
        </div>

        <div className="mb-4">
          <label className={`mb-1 block ${labelType} text-muted`} htmlFor="workspace-dir">
            Working Directory
          </label>
          <div className="mb-2">
            <DirectoryPicker selected={workingDir} onSelect={setWorkingDir} />
          </div>
          <input
            id="workspace-dir"
            className={`${field} font-data`}
            value={workingDir}
            onChange={(e) => setWorkingDir(e.target.value)}
            placeholder="/home/dev/project"
            required
          />
        </div>

        {error && <p className="mb-3 text-fail">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !name || !workingDir} className={btnPrimary}>
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function WorkspaceSwitcher({
  workspaces,
  activeId,
  onSwitch,
  onCreated,
}: {
  workspaces: Workspace[];
  activeId: number | null;
  onSwitch: (id: number) => void;
  onCreated: (workspace: Workspace) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (workspaces.length === 0) return null;

  const active = workspaces.find((w) => w.id === activeId) ?? workspaces[0];
  if (!active) return null;

  return (
    <div className="relative" ref={wrap}>
      <button
        type="button"
        aria-label="Active workspace"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-edge bg-field px-[11px] py-[9px] font-semibold text-ink"
      >
        <span className="truncate">{active.name}</span>
        <Icon
          name="chevron-down"
          className={`size-3.5 shrink-0 text-muted transition-transform duration-150 ${open ? 'rotate-0' : '-rotate-90'}`}
        />
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-md bg-surface py-1 shadow-bar"
        >
          {workspaces.map((w) => (
            <li
              key={w.id}
              role="option"
              aria-selected={w.id === active.id}
              className={`flex cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 font-medium ${
                w.id === active.id ? 'bg-raised text-ink' : 'text-muted'
              }`}
              onPointerDown={() => {
                onSwitch(w.id);
                setOpen(false);
              }}
            >
              <span className="truncate">{w.name}</span>
              {w.id === active.id && <Icon name="check" className="shrink-0 text-accent" />}
            </li>
          ))}
          <li role="presentation" className="mx-1 my-1 border-t border-edge" />
          <li
            role="option"
            aria-selected={false}
            className="cursor-pointer px-2.5 py-1.5 font-medium text-muted"
            onPointerDown={() => {
              setCreating(true);
              setOpen(false);
            }}
          >
            + New workspace…
          </li>
        </ul>
      )}

      {creating && <NewWorkspaceForm onClose={() => setCreating(false)} onCreated={onCreated} />}
    </div>
  );
}
