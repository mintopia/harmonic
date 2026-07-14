import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
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
import { Icon } from './components/Icon';
import { loadRailCollapsed, storeRailCollapsed } from './rail-model';
import { btnPrimary, labelType } from './ui';

const VIEWS = ['board', 'table', 'stats'] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABELS: Record<View, string> = { board: 'Board', table: 'Table', stats: 'Stats' };

// Mirrors --breakpoint-rail (index.css): collapsed-only a11y attributes
// must not leak into the mobile drawer, so JS needs the same threshold.
const RAIL_QUERY = '(min-width: 900px)';
function useRailBreakpoint() {
  return useSyncExternalStore(
    (onChange) => {
      const mq = matchMedia(RAIL_QUERY);
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    },
    () => matchMedia(RAIL_QUERY).matches,
  );
}

// Collapse only applies at the rail breakpoint; the mobile drawer always
// shows icon + label, so collapsed styles are rail:-prefixed throughout.
const railItem = (active: boolean, collapsed: boolean) =>
  `flex w-full items-center gap-2 overflow-hidden whitespace-nowrap rounded-md px-2.5 py-1.5 text-left transition-colors duration-150 ${
    collapsed ? 'rail:justify-center rail:px-0' : ''
  } ${active ? 'bg-raised text-accent-text' : 'text-muted hover:text-ink'}`;

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
  const [railCollapsed, setRailCollapsed] = useState(() => loadRailCollapsed(localStorage));
  const railDesktop = useRailBreakpoint();
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

  const toggleRail = () => {
    const next = !railCollapsed;
    setRailCollapsed(next);
    storeRailCollapsed(localStorage, next);
  };

  // Collapsed items keep their accessible name and gain a native tooltip;
  // when the label is visible neither is needed — below the breakpoint the
  // drawer shows labels, so the attributes must not apply there.
  const railItemName = (label: string) =>
    railCollapsed && railDesktop ? { 'aria-label': label, title: label } : {};

  // Hidden, not unmounted, when collapsed: keyboard order and focus
  // behavior stay identical in both widths.
  const railLabel = railCollapsed ? 'rail:hidden' : '';

  const navItems = (
    <>
      <nav aria-label="Views" className="flex flex-col gap-0.5 rail:flex-1">
        {VIEWS.map((v) => (
          <button
            key={v}
            aria-current={view === v ? 'page' : undefined}
            {...railItemName(VIEW_LABELS[v])}
            className={railItem(view === v, railCollapsed)}
            onClick={() => pickView(v)}
          >
            <Icon name={v} />
            <span className={railLabel}>{VIEW_LABELS[v]}</span>
          </button>
        ))}
      </nav>
      {/* Desktop only: below the rail breakpoint the top drawer wins. */}
      <div className="mt-2 hidden border-t border-hairline pt-2 rail:flex rail:flex-col">
        <button
          aria-expanded={!railCollapsed}
          aria-label={railCollapsed ? 'Expand rail' : 'Collapse rail'}
          title={railCollapsed ? 'Expand rail' : 'Collapse rail'}
          className={railItem(false, railCollapsed)}
          onClick={toggleRail}
        >
          <Icon className={railCollapsed ? '-scale-x-100' : ''} name="chevrons-left" />
          <span className={railLabel}>Collapse</span>
        </button>
      </div>
      <div className="mt-2 flex flex-col gap-0.5 border-t border-hairline pt-2 rail:mt-0">
        <button {...railItemName('Channels')} className={railItem(false, railCollapsed)} onClick={() => { setShowChannels(true); setMenuOpen(false); }}>
          <Icon name="channels" />
          <span className={railLabel}>Channels</span>
        </button>
        <button {...railItemName('Keys')} className={railItem(false, railCollapsed)} onClick={() => { setShowKeys(true); setMenuOpen(false); }}>
          <Icon name="keys" />
          <span className={railLabel}>Keys</span>
        </button>
        <button
          {...railItemName('Log out')}
          className={railItem(false, railCollapsed)}
          onClick={() => fetch('/api/auth/logout', { method: 'POST' }).then(() => setAuthed(false))}
        >
          <Icon name="logout" />
          <span className={railLabel}>Log out</span>
        </button>
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen flex-col rail:flex-row">
      {/* The rail: navigation lives here; above the working view is status only. */}
      <aside
        className={`border-b border-hairline rail:flex rail:shrink-0 rail:flex-col rail:overflow-hidden rail:border-b-0 rail:border-r rail:transition-[width] rail:duration-150 rail:ease-out motion-reduce:rail:transition-none ${
          railCollapsed ? 'rail:w-9' : 'rail:w-[200px]'
        }`}
      >
        <div className={`flex items-center px-3 py-2.5 rail:px-2 rail:pb-4 ${railCollapsed ? 'rail:justify-center rail:px-0' : ''}`}>
          <span className={`whitespace-nowrap px-1 text-title font-semibold ${railCollapsed ? 'rail:hidden' : ''}`}>AgentDeck</span>
          {railCollapsed && (
            <span className="hidden text-title font-semibold rail:inline" title="AgentDeck">
              <span aria-hidden="true">AD</span>
              <span className="sr-only">AgentDeck</span>
            </span>
          )}
          <button
            aria-expanded={menuOpen}
            aria-label="Menu"
            className="ml-auto rounded-md px-2.5 py-1.5 text-muted hover:text-ink rail:hidden"
            onClick={() => setMenuOpen((open) => !open)}
          >
            Menu
          </button>
        </div>
        <div
          className={`${menuOpen ? 'flex' : 'hidden'} flex-col gap-0.5 border-t border-hairline p-2 rail:flex rail:flex-1 rail:border-t-0 rail:pt-0 ${
            railCollapsed ? 'rail:px-1' : ''
          }`}
        >
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
