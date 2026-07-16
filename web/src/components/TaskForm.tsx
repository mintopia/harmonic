import { useState, type FormEvent } from 'react';
import { api } from '../api';
import type { AppConfig, Task } from '../types';
import { Modal } from './Modal';
import { ModelCombobox } from './ModelCombobox';
import { btnGhost, btnPrimary, btnQuiet, field, panelTitle, labelType } from '../ui';

const label = `mb-1 block ${labelType} text-muted`;

export function TaskForm({
  config,
  task,
  onClose,
  onSaved,
}: {
  config: AppConfig;
  task: Task | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [prompt, setPrompt] = useState(task?.prompt ?? '');
  const [harness, setHarness] = useState(task?.harness ?? config.defaults.harness);
  const [model, setModel] = useState(task?.model ?? config.harnesses[config.defaults.harness]?.defaultModel ?? '');
  const [workingDir, setWorkingDir] = useState(task?.workingDir ?? config.defaults.workingDir);
  const [isolationMode, setIsolationMode] = useState(task?.isolationMode ?? config.defaults.isolationMode);
  const [priority, setPriority] = useState(task?.priority ?? config.defaults.priority);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const models = config.harnesses[harness]?.models ?? [];

  const save = async (state?: 'draft' | 'ready') => {
    setBusy(true);
    setError(null);
    try {
      const fields = { prompt, harness, model, workingDir, isolationMode, priority };
      if (task) await api.updateTask(task.id, fields);
      else await api.createTask({ ...fields, ...(state ? { state } : {}) });
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

  const pickHarness = (h: string) => {
    setHarness(h);
    const cfg = config.harnesses[h];
    if (cfg) setModel(cfg.defaultModel);
  };

  return (
    <Modal label={task ? `Edit task #${task.id}` : 'New task'} onClose={onClose} className="max-w-lg">
      <form onSubmit={submit} className="p-5">
        <h2 className={`${panelTitle} mb-4`}>{task ? `Edit task #${task.id}` : 'New task'}</h2>

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
          <div>
            <label className={label} htmlFor="task-harness">Harness</label>
            <select id="task-harness" className={field} value={harness} onChange={(e) => pickHarness(e.target.value)}>
              {Object.keys(config.harnesses).map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="task-model">Model (pick or type any ID)</label>
            <ModelCombobox id="task-model" value={model} onChange={setModel} options={models} />
          </div>
          <div>
            <label className={label} htmlFor="task-isolation">Isolation Mode</label>
            <select
              id="task-isolation"
              className={field}
              value={isolationMode}
              onChange={(e) => setIsolationMode(e.target.value as 'direct' | 'worktree')}
            >
              <option value="direct">direct</option>
              <option value="worktree">worktree</option>
            </select>
          </div>
          <div>
            <label className={label} htmlFor="task-priority">Priority</label>
            <select
              id="task-priority"
              className={field}
              value={priority}
              onChange={(e) => setPriority(e.target.value as 'high' | 'normal' | 'low')}
            >
              <option value="high">high</option>
              <option value="normal">normal</option>
              <option value="low">low</option>
            </select>
          </div>
        </div>

        <div className="mb-4">
          <label className={label} htmlFor="task-workdir">Working Directory</label>
          <input id="task-workdir" className={`${field} font-data`} value={workingDir} onChange={(e) => setWorkingDir(e.target.value)} />
        </div>

        {error && <p className="mb-3 text-fail">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={`${btnQuiet} px-3 py-1.5`}>
            Close
          </button>
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
