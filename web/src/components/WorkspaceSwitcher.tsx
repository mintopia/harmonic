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
 * Per-Workspace settings (issue #45): rename + tracker mirroring. Tracker
 * mirroring is per-Workspace — off ⇒ no poll loop, so new tracker issues never
 * appear on this board. This is the only surface that flips it.
 */
function EditWorkspaceForm({
  workspace,
  onClose,
  onUpdated,
}: {
  workspace: Workspace;
  onClose: () => void;
  onUpdated: (w: Workspace) => void;
}) {
  const [name, setName] = useState(workspace.name);
  const [trackerEnabled, setTrackerEnabled] = useState(workspace.trackerEnabled);
  const [pollInterval, setPollInterval] = useState(workspace.trackerPollIntervalSeconds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateWorkspace(workspace.id, {
        name,
        trackerEnabled,
        trackerPollIntervalSeconds: pollInterval,
      });
      onUpdated(updated);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal label="Workspace settings" onClose={onClose} className="max-w-md">
      <form onSubmit={submit} className="p-5">
        <h2 className={`${panelTitle} mb-4`}>Workspace settings</h2>

        <div className="mb-3">
          <label className={`mb-1 block ${labelType} text-muted`} htmlFor="edit-workspace-name">
            Name
          </label>
          <input
            id="edit-workspace-name"
            className={field}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>

        <div className="mb-4">
          <span className={`mb-1 block ${labelType} text-muted`}>Working Directory</span>
          <p className="font-data text-sm text-muted break-all">{workspace.workingDir}</p>
        </div>

        <div className="mb-3 rounded-md border border-hairline p-3">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={trackerEnabled}
              onChange={(e) => setTrackerEnabled(e.target.checked)}
            />
            <span className="text-sm font-medium">Mirror tracker issues onto this board</span>
          </label>
          <p className="mt-1 text-xs text-muted">
            Polls this Working Directory's repo and projects its issues as mirrored Tasks. Off means no poll loop.
          </p>

          {trackerEnabled && (
            <div className="mt-3">
              <label className={`mb-1 block ${labelType} text-muted`} htmlFor="edit-workspace-poll">
                Poll interval (seconds)
              </label>
              <input
                id="edit-workspace-poll"
                type="number"
                min={5}
                className={`${field} w-32`}
                value={pollInterval}
                onChange={(e) => setPollInterval(Number(e.target.value))}
              />
            </div>
          )}
        </div>

        {error && <p className="mb-3 text-fail">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !name} className={btnPrimary}>
            Save
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
 * honest fit for "pick one of a short named list". The gear opens per-Workspace
 * settings (rename, tracker mirroring — issue #45).
 */
export function WorkspaceSwitcher({
  workspaces,
  activeId,
  onSwitch,
  onCreated,
  onUpdated,
}: {
  workspaces: Workspace[];
  activeId: number | null;
  onSwitch: (id: number) => void;
  onCreated: (workspace: Workspace) => void;
  onUpdated: (workspace: Workspace) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);

  if (workspaces.length === 0) return null;

  const active = workspaces.find((w) => w.id === activeId) ?? null;

  return (
    <div className="flex items-center gap-2">
      <select
        aria-label="Active workspace"
        className={`${field} min-w-0 flex-1`}
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

      {active && (
        <button
          type="button"
          className={`${btnGhost} shrink-0 px-2`}
          aria-label="Workspace settings"
          title="Workspace settings"
          onClick={() => setEditing(true)}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      )}

      {creating && (
        <NewWorkspaceForm
          onClose={() => setCreating(false)}
          onCreated={(w) => {
            onCreated(w);
            onSwitch(w.id);
          }}
        />
      )}

      {editing && active && (
        <EditWorkspaceForm workspace={active} onClose={() => setEditing(false)} onUpdated={onUpdated} />
      )}
    </div>
  );
}
