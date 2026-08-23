import { useState, type FormEvent } from 'react';
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

  if (workspaces.length === 0) return null;

  const active = workspaces.find((w) => w.id === activeId) ?? workspaces[0];
  if (!active) return null;
  // The parent directory, tilde-abbreviated, as the "~/src/" locator line.
  const parent = (() => {
    const dir = active.workingDir ?? '';
    const p = dir.replace(/\/[^/]*\/?$/, '');
    if (!p) return '~/';
    return `${p.replace(/^\/home\/[^/]+/, '~')}/`;
  })();

  return (
    <div className="relative rounded-md border border-edge bg-field px-[11px] py-[9px]">
      <div className="truncate font-data text-[11px] text-faint">{parent}</div>
      <div className="mt-px flex items-center justify-between gap-2 font-semibold text-ink">
        <span className="truncate">{active.name}</span>
        <Icon name="chevron-down" className="size-3.5 shrink-0 text-muted" />
      </div>
      <select
        aria-label="Active workspace"
        className="absolute inset-0 cursor-pointer opacity-0"
        value={activeId ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__new') setCreating(true);
          else onSwitch(Number(v));
        }}
      >
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
        <option value="__new">+ New workspace…</option>
      </select>

      {creating && <NewWorkspaceForm onClose={() => setCreating(false)} onCreated={onCreated} />}
    </div>
  );
}
