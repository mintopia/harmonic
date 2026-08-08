import { useState, type FormEvent } from 'react';
import { api } from '../api';
import type { Workspace } from '../types';
import { Modal } from './Modal';
import { btnGhost, btnPrimary, field, labelType, panelTitle } from '../ui';

const NEW_WORKSPACE = '__new__';

function NewWorkspaceForm({ onClose, onCreated }: { onClose: () => void; onCreated: (w: Workspace) => void }) {
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

/**
 * The sidebar Workspace switcher (ADR-0008, issue #41): picks the active
 * Workspace that Board/Table/Stats and the status strip scope to, and where
 * a new Task/Conversation lands. A plain `<select>`, matching the filter
 * selects elsewhere (TableView) rather than a bespoke popover — the fastest
 * honest fit for "pick one of a short named list".
 */
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

  return (
    <div>
      <select
        aria-label="Active workspace"
        className={`${field} w-full`}
        value={activeId ?? ''}
        onChange={(e) => {
          if (e.target.value === NEW_WORKSPACE) setCreating(true);
          else onSwitch(Number(e.target.value));
        }}
      >
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
        <option value={NEW_WORKSPACE}>+ New workspace…</option>
      </select>

      {creating && (
        <NewWorkspaceForm
          onClose={() => setCreating(false)}
          onCreated={(w) => {
            onCreated(w);
            onSwitch(w.id);
          }}
        />
      )}
    </div>
  );
}
