import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { AppConfig, Task } from './types';
import { Board } from './components/Board';
import { TaskForm } from './components/TaskForm';
import { TaskDetail } from './components/TaskDetail';
import { subscribe } from './ws';

export function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [editing, setEditing] = useState<Task | 'new' | null>(null);
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { tasks } = await api.tasks();
      setTasks(tasks);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    api.config().then(setConfig).catch(() => {});
    refresh();
    // Live updates over WebSocket; slow polling as a reconnect safety net.
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'task_changed') {
        setTasks((current) => {
          const rest = current.filter((t) => t.id !== msg.task.id);
          return [...rest, msg.task];
        });
        setOpenTask((current) => (current && current.id === msg.task.id ? msg.task : current));
      }
    });
    const timer = setInterval(refresh, 10_000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [refresh]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-4 border-b border-zinc-800 px-6 py-3">
        <h1 className="text-lg font-semibold tracking-tight">
          Agent<span className="text-amber-400">Deck</span>
        </h1>
        <div className="flex-1" />
        {config && (
          <button
            onClick={() =>
              api
                .updateConfig({ autoRunner: { enabled: !config.autoRunner.enabled } })
                .then(setConfig, (e) => alert(e.message))
            }
            className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${
              config.autoRunner.enabled
                ? 'border-emerald-700 bg-emerald-950/60 text-emerald-300'
                : 'border-zinc-700 text-zinc-400'
            }`}
            title={`Max concurrent runs: ${config.autoRunner.maxConcurrentRuns}`}
          >
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                config.autoRunner.enabled ? 'bg-emerald-400' : 'bg-zinc-600'
              }`}
            />
            Auto-Runner {config.autoRunner.enabled ? 'on' : 'off'}
            <span className="text-xs text-zinc-500">
              {tasks.filter((t) => t.state === 'running').length}/{config.autoRunner.maxConcurrentRuns} running
            </span>
          </button>
        )}
        <button
          onClick={() => setEditing('new')}
          className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-amber-400"
        >
          New Task
        </button>
      </header>

      {error && (
        <div className="mx-6 mt-4 rounded-md border border-red-800 bg-red-950 px-4 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      <main className="p-4">
        <Board tasks={tasks} onEdit={setEditing} onOpen={setOpenTask} onChanged={refresh} />
      </main>

      {openTask && <TaskDetail task={openTask} onClose={() => setOpenTask(null)} />}

      {editing !== null && config && (
        <TaskForm
          config={config}
          task={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
