import { useState, type FormEvent } from 'react';
import { api } from '../api';
import type { AppConfig, Task } from '../types';

const field =
  'w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 focus:border-amber-500 focus:outline-none';
const label = 'mb-1 block text-xs font-medium text-zinc-400';

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
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
      >
        <h2 className="mb-4 text-base font-semibold">{task ? `Edit Task #${task.id}` : 'New Task'}</h2>

        <div className="mb-3">
          <label className={label}>Prompt</label>
          <textarea
            className={`${field} min-h-28`}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            autoFocus
            required
          />
        </div>

        <div className="mb-3 grid grid-cols-2 gap-3">
          <div>
            <label className={label}>Harness</label>
            <select className={field} value={harness} onChange={(e) => pickHarness(e.target.value)}>
              {Object.keys(config.harnesses).map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={label}>Model (pick or type any ID)</label>
            <input className={field} value={model} onChange={(e) => setModel(e.target.value)} list="models" />
            <datalist id="models">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
          <div>
            <label className={label}>Isolation Mode</label>
            <select
              className={field}
              value={isolationMode}
              onChange={(e) => setIsolationMode(e.target.value as 'direct' | 'worktree')}
            >
              <option value="direct">direct</option>
              <option value="worktree">worktree</option>
            </select>
          </div>
          <div>
            <label className={label}>Priority</label>
            <select
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
          <label className={label}>Working Directory</label>
          <input className={field} value={workingDir} onChange={(e) => setWorkingDir(e.target.value)} />
        </div>

        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-100">
            Close
          </button>
          {!task && (
            <button
              type="button"
              disabled={busy || !prompt}
              onClick={() => save('draft')}
              className="rounded-md border border-zinc-600 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            >
              Save Draft
            </button>
          )}
          <button
            type="submit"
            disabled={busy || !prompt}
            className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {task ? 'Save' : 'Create Ready'}
          </button>
        </div>
      </form>
    </div>
  );
}
