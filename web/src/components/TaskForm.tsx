import { useState, type FormEvent } from 'react';
import { api } from '../api';
import type { AppConfig, Task, Workspace } from '../types';
import { Modal } from './Modal';
import { ModelCombobox } from './ModelCombobox';
import { InheritField } from './InheritField';
import { inheritSource } from './inherit-field-model';
import { btnGhost, btnPrimary, field, panelTitle, labelType, selectField } from '../ui';
import { taskLabel } from '../id-format.js';
import { useLiveEffect } from '../useLiveEffect';

const label = `mb-1 block ${labelType} text-muted`;

type Overrides = Task['overrides'];

export function TaskForm({
  config,
  task,
  workspace,
  workspaceId,
  onClose,
  onSaved,
}: {
  config: AppConfig;
  task: Task | null;
  /** The active Workspace, for the inherited (effective) default each field
   * shows while inheriting; null when there's no Workspace yet. */
  workspace: Workspace | null;
  /** The active Workspace a new task binds to; ignored when editing. */
  workspaceId: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [prompt, setPrompt] = useState(task?.prompt ?? '');
  useLiveEffect((live) => {
    if (!task || task.prompt !== undefined) return;
    api
      .task(task.id)
      .then((full) => {
        if (live() && full.prompt !== undefined) setPrompt(full.prompt);
      })
      .catch(() => {});
  }, [task]);
  const [ov, setOv] = useState<Overrides>(
    task?.overrides ?? {
      harness: null,
      model: null,
      isolationMode: null,
      priority: null,
      conflictResolveTurns: null,
    },
  );
  const [workingDir, setWorkingDir] = useState(task?.workingDir ?? config.defaults.workingDir);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof Overrides>(key: K, value: Overrides[K]) =>
    setOv((current) => ({ ...current, [key]: value }));

  const effHarness = ov.harness ?? workspace?.harness ?? config.defaults.harness;
  const inheritedModel = workspace?.model ?? config.harnesses[effHarness]?.defaultModel ?? '';
  const models = config.harnesses[effHarness]?.models ?? [];

  const showWorkingDir = !!task || workspaceId === null;

  const save = async (state?: 'draft' | 'ready') => {
    setBusy(true);
    setError(null);
    try {
      if (task) {
        await api.updateTask(task.id, { ...ov, prompt, workingDir });
      } else {
        const pinned = Object.fromEntries(Object.entries(ov).filter(([, v]) => v !== null));
        await api.createTask({
          prompt,
          ...pinned,
          ...(showWorkingDir ? { workingDir } : {}),
          ...(state ? { state } : {}),
          ...(workspaceId !== null ? { workspaceId } : {}),
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save(task ? undefined : 'ready');
  };

  return (
    <Modal label={task ? `Edit ${taskLabel(task.id)}` : 'New task'} onClose={onClose} className="max-w-lg">
      <form onSubmit={submit} className="p-5">
        <h2 className={`${panelTitle} mb-4`}>{task ? `Edit ${taskLabel(task.id)}` : 'New task'}</h2>

        <div className="mb-3">
          <label className={label} htmlFor="task-prompt">Prompt</label>
          <textarea
            id="task-prompt"
            className={`${field} min-h-28`}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            autoFocus
            required
          />
        </div>

        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <InheritField
            label="Harness"
            htmlFor="task-harness"
            value={ov.harness}
            inherited={workspace?.harness ?? config.defaults.harness}
            inheritedFrom={inheritSource(workspace?.harness)}
            onChange={(harness) => set('harness', harness)}
          >
            {({ id, value, onChange }) => (
              <select id={id} className={`${selectField} w-full`} value={value} onChange={(e) => onChange(e.target.value)}>
                {Object.keys(config.harnesses).map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
            )}
          </InheritField>

          <InheritField
            label="Model"
            htmlFor="task-model"
            value={ov.model}
            inherited={inheritedModel}
            inheritedFrom={inheritSource(workspace?.model)}
            onChange={(model) => set('model', model)}
          >
            {({ id, value, onChange }) => (
              <ModelCombobox id={id} value={value} onChange={onChange} options={models} />
            )}
          </InheritField>

          <InheritField
            label="Isolation Mode"
            htmlFor="task-isolation"
            value={ov.isolationMode}
            inherited={workspace?.isolationMode ?? config.defaults.isolationMode}
            inheritedFrom={inheritSource(workspace?.isolationMode)}
            onChange={(isolationMode) => set('isolationMode', isolationMode)}
          >
            {({ id, value, onChange }) => (
              <select
                id={id}
                className={`${selectField} w-full`}
                value={value}
                onChange={(e) => onChange(e.target.value as 'direct' | 'worktree')}
              >
                <option value="direct">direct</option>
                <option value="worktree">worktree</option>
              </select>
            )}
          </InheritField>

          <InheritField
            label="Priority"
            htmlFor="task-priority"
            value={ov.priority}
            inherited={workspace?.priority ?? config.defaults.priority}
            inheritedFrom={inheritSource(workspace?.priority)}
            onChange={(priority) => set('priority', priority)}
          >
            {({ id, value, onChange }) => (
              <select
                id={id}
                className={`${selectField} w-full`}
                value={value}
                onChange={(e) => onChange(e.target.value as 'high' | 'normal' | 'low')}
              >
                <option value="high">high</option>
                <option value="normal">normal</option>
                <option value="low">low</option>
              </select>
            )}
          </InheritField>

          <InheritField
            label="Conflict resolve turns"
            htmlFor="task-conflict-turns"
            value={ov.conflictResolveTurns}
            inherited={workspace?.conflictResolveTurns ?? config.defaults.conflictResolveTurns}
            inheritedFrom={inheritSource(workspace?.conflictResolveTurns)}
            onChange={(conflictResolveTurns) => set('conflictResolveTurns', conflictResolveTurns)}
            description="How many agentic turns may attempt to resolve a merge conflict before the Attempt escalates."
          >
            {({ id, value, onChange }) => (
              <input
                id={id}
                type="number"
                min={0}
                className={`${field} w-full tabular-nums`}
                value={value}
                onChange={(e) => onChange(Number(e.target.value))}
              />
            )}
          </InheritField>
        </div>

        {showWorkingDir && (
          <div className="mb-4">
            <label className={label} htmlFor="task-workdir">Working Directory</label>
            <input id="task-workdir" className={`${field} font-data`} value={workingDir} onChange={(e) => setWorkingDir(e.target.value)} />
          </div>
        )}

        {error && <p className="mb-3 text-fail">{error}</p>}

        <div className="flex justify-end gap-2">
          {!task && (
            <button type="button" disabled={busy || !prompt} onClick={() => save('draft')} className={btnGhost}>
              Save draft
            </button>
          )}
          <button type="submit" disabled={busy || !prompt} className={btnPrimary}>
            {task ? 'Save' : 'Create ready'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
