import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { formatCost } from './cost';
import type { AppConfig, Cost, Task } from './types';
import { Board } from './components/Board';
import { TaskForm } from './components/TaskForm';
import { TaskDetail } from './components/TaskDetail';
import { subscribe } from './ws';
import { Login } from './components/Login';
import { ApiKeys } from './components/ApiKeys';
import { StatsPage } from './components/StatsPage';
import { TableView } from './components/TableView';
import { Channels } from './components/Channels';
import { btnPrimary, labelType } from './ui';

const VIEWS = ['board', 'table', 'stats'] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABELS: Record<View, string> = { board: 'Board', table: 'Table', stats: 'Stats' };

const railItem = (active: boolean) =>
  `w-full rounded-md px-2.5 py-1.5 text-left transition-colors duration-150 ${
    active ? 'bg-raised text-accent-text' : 'text-muted hover:text-ink'
  }`;

/** Cost over the trailing 24h — the status strip's period cost. */
function usePeriodCost(authed: boolean, tasks: Task[] | null) {
  const [cost, setCost] = useState<Cost | null>(null);
  // Runs finishing move cost, and every finish changes the running count;
  // together with the task count this catches the transitions that matter.
  const shape = tasks ? `${tasks.length}:${tasks.filter((t) => t.state === 'running').length}` : '';
  useEffect(() => {
    if (!authed) return;
    let live = true;
    const load = () => {
      const to = Date.now();
      fetch(`/api/stats?from=${to - 24 * 3600_000}&to=${to}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((s: { cost: Cost | null } | null) => live && s && setCost(s.cost))
        .catch(() => {}); // status readout only — never worth an alert
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [authed, shape]);
  return cost;
}

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  // null = first load still in flight; lets the board tell "loading" from "no tasks yet".
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [editing, setEditing] = useState<Task | 'new' | null>(null);
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [showChannels, setShowChannels] = useState(false);
  const [view, setView] = useState<View>('board');
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((me: { authenticated: boolean }) => setAuthed(me.authenticated))
      .catch(() => setAuthed(false));
  }, []);

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
    if (!authed) return;
    api.config().then(setConfig).catch(() => {});
    refresh();
    // Live updates over WebSocket; slow polling as a reconnect safety net.
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'task_changed') {
        setTasks((current) => {
          const rest = (current ?? []).filter((t) => t.id !== msg.task.id);
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
  }, [refresh, authed]);

  const periodCost = usePeriodCost(authed === true, tasks);

  if (authed === null) return null;
  if (!authed) return <Login onLoggedIn={() => setAuthed(true)} />;

  const taskList = tasks ?? [];
  const runningCount = taskList.filter((t) => t.state === 'running').length;
  const cost24h = formatCost(periodCost);

  const pickView = (v: View) => {
    setView(v);
    setMenuOpen(false);
  };

  const navItems = (
    <>
      <nav aria-label="Views" className="flex flex-col gap-0.5 rail:flex-1">
        {VIEWS.map((v) => (
          <button key={v} aria-current={view === v ? 'page' : undefined} className={railItem(view === v)} onClick={() => pickView(v)}>
            {VIEW_LABELS[v]}
          </button>
        ))}
      </nav>
      <div className="mt-2 flex flex-col gap-0.5 border-t border-hairline pt-2 rail:mt-0">
        <button className={railItem(false)} onClick={() => { setShowChannels(true); setMenuOpen(false); }}>
          Channels
        </button>
        <button className={railItem(false)} onClick={() => { setShowKeys(true); setMenuOpen(false); }}>
          Keys
        </button>
        <button
          className={railItem(false)}
          onClick={() => fetch('/api/auth/logout', { method: 'POST' }).then(() => setAuthed(false))}
        >
          Log out
        </button>
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen flex-col rail:flex-row">
      {/* The rail: navigation lives here; above the working view is status only. */}
      <aside className="border-b border-hairline rail:flex rail:w-[200px] rail:shrink-0 rail:flex-col rail:border-b-0 rail:border-r">
        <div className="flex items-center px-3 py-2.5 rail:px-2 rail:pb-4">
          <span className="px-1 text-title font-semibold">AgentDeck</span>
          <button
            aria-expanded={menuOpen}
            aria-label="Menu"
            className="ml-auto rounded-md px-2.5 py-1.5 text-muted hover:text-ink rail:hidden"
            onClick={() => setMenuOpen((open) => !open)}
          >
            Menu
          </button>
        </div>
        <div className={`${menuOpen ? 'flex' : 'hidden'} flex-col gap-0.5 border-t border-hairline p-2 rail:flex rail:flex-1 rail:border-t-0 rail:pt-0`}>
          {navItems}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-hairline px-4 py-2.5">
          {config && (
            <button
              onClick={() =>
                api
                  .updateConfig({ autoRunner: { enabled: !config.autoRunner.enabled } })
                  .then(setConfig, (e) => alert(e.message))
              }
              aria-pressed={config.autoRunner.enabled}
              className={`rounded-md ${labelType} text-muted hover:text-ink`}
              title={`Max concurrent runs: ${config.autoRunner.maxConcurrentRuns}`}
            >
              Auto-Runner <span className={config.autoRunner.enabled ? 'text-accent-text' : ''}>{config.autoRunner.enabled ? 'on' : 'off'}</span>
            </button>
          )}
          {config && (
            <span className={`${labelType} ${runningCount > 0 ? 'text-running' : 'text-muted'}`}>
              {runningCount}/{config.autoRunner.maxConcurrentRuns} running
            </span>
          )}
          {cost24h && (
            <span className={`${labelType} text-muted`} title="Cost over the last 24 hours">
              24h <span className="font-data normal-case tracking-normal">{cost24h}</span>
            </span>
          )}
          <div className="flex-1" />
          <button onClick={() => setEditing('new')} className={btnPrimary}>
            New Task
          </button>
        </header>

        {error && (
          <div className="mx-4 mt-3 rounded-md border border-fail px-4 py-2 text-fail">
            {error}
          </div>
        )}

        <main className="min-w-0 flex-1 px-4 py-3">
          {view === 'board' && (
            <Board tasks={taskList} loading={tasks === null} onEdit={setEditing} onOpen={setOpenTask} onChanged={refresh} />
          )}
          {view === 'table' && <TableView onOpen={setOpenTask} />}
          {view === 'stats' && <StatsPage />}
        </main>
      </div>

      {openTask && <TaskDetail task={openTask} onClose={() => setOpenTask(null)} />}
      {showKeys && <ApiKeys onClose={() => setShowKeys(false)} />}
      {showChannels && <Channels onClose={() => setShowChannels(false)} />}

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
