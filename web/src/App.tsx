import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import { formatCost } from './cost';
import type { AppConfig, Cost, Task } from './types';
import { Board } from './components/Board';
import { TaskForm } from './components/TaskForm';
import { TaskDetail } from './components/TaskDetail';
import { subscribe } from './ws';
import { Login } from './components/Login';
import { ApiPage } from './components/ApiPage';
import { StatsPage } from './components/StatsPage';
import { SettingsPage } from './components/SettingsPage';
import { TableView } from './components/TableView';
import { BrandMark } from './components/BrandMark';
import { Icon, type IconName } from './components/Icon';
import { Switch } from './components/Switch';
import { VIEW_LABELS, VIEWS, loadRailCollapsed, storeRailCollapsed } from './rail-model';
import type { View } from './rail-model';
import { applyTheme, loadTheme, nextTheme, storeTheme, type ThemePref } from './theme';
import { btnPrimary } from './ui';

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
// Active is the sidebar's only accent: an indigo tint under indigo text.
const railItem = (active: boolean, collapsed: boolean) =>
  `flex w-full items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-md px-2.5 py-1.5 text-left transition-colors duration-150 ${
    collapsed ? 'rail:justify-center rail:px-0' : ''
  } ${active ? 'bg-accent-tint font-semibold text-accent' : 'font-medium text-muted hover:bg-raised hover:text-ink'}`;

const THEME_ICONS: Record<ThemePref, IconName> = {
  system: 'circle-half',
  light: 'sun',
  dark: 'moon',
};
const THEME_LABELS: Record<ThemePref, string> = {
  system: 'Theme: System',
  light: 'Theme: Light',
  dark: 'Theme: Dark',
};

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
  const [view, setView] = useState<View>('board');
  const [menuOpen, setMenuOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(() => loadRailCollapsed(localStorage));
  const [theme, setTheme] = useState<ThemePref>(() => loadTheme(localStorage));
  const railDesktop = useRailBreakpoint();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    applyTheme(document.documentElement, theme);
  }, [theme]);

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
      // Keep an open detail modal fresh from the poll too, not only the
      // socket — otherwise its state-aware footer can go stale (and keep
      // offering Accept on an already-completed task) if the ws drops.
      setOpenTask((current) => (current ? tasks.find((t) => t.id === current.id) ?? current : current));
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

  const cycleTheme = () => {
    const next = nextTheme(theme);
    setTheme(next);
    storeTheme(localStorage, next);
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
      {/* Desktop only: the nav's rail:flex-1 above pins this to the sidebar
          foot. Below the rail breakpoint the top drawer wins. */}
      <div className="mt-2 hidden border-t border-hairline pt-2 rail:flex rail:flex-col">
        <button
          aria-expanded={!railCollapsed}
          aria-label={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={railItem(false, railCollapsed)}
          onClick={toggleRail}
        >
          <Icon className={railCollapsed ? '-scale-x-100' : ''} name="chevrons-left" />
          <span className={railLabel}>Collapse</span>
        </button>
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen flex-col rail:flex-row">
      {/* The sidebar: navigation lives here; above the working view is status only. */}
      <aside
        className={`border-b border-hairline bg-shell rail:flex rail:shrink-0 rail:flex-col rail:overflow-hidden rail:border-b-0 rail:border-r rail:transition-[width] rail:duration-150 rail:ease-out motion-reduce:rail:transition-none ${
          railCollapsed ? 'rail:w-12' : 'rail:w-[200px]'
        }`}
      >
        <div
          className={`flex items-center gap-2.5 px-4 py-3 rail:px-3 rail:pb-5 ${railCollapsed ? 'rail:justify-center rail:px-0' : ''}`}
        >
          <BrandMark />
          <span className={`whitespace-nowrap text-title font-bold tracking-tight ${railCollapsed ? 'rail:hidden' : ''}`}>
            Harmonic
          </span>
          {railCollapsed && <span className="sr-only">Harmonic</span>}
          <button
            aria-expanded={menuOpen}
            aria-label="Menu"
            className="ml-auto rounded-md px-2.5 py-1.5 font-medium text-muted hover:text-ink rail:hidden"
            onClick={() => setMenuOpen((open) => !open)}
          >
            Menu
          </button>
        </div>
        <div
          className={`${menuOpen ? 'flex' : 'hidden'} flex-col gap-0.5 border-t border-hairline p-2 rail:flex rail:flex-1 rail:border-t-0 rail:pt-0 ${
            railCollapsed ? 'rail:px-1.5' : ''
          }`}
        >
          {navItems}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-hairline bg-shell px-6 py-3">
          {config && (
            <Switch
              checked={config.autoRunner.enabled}
              label="Auto-runner"
              onChange={(enabled) =>
                api.updateConfig({ autoRunner: { enabled } }).then(setConfig, (e) => alert(e.message))
              }
            >
              <span
                className="font-medium text-muted"
                title={`Max concurrent runs: ${config.autoRunner.maxConcurrentRuns}`}
              >
                Auto-runner
              </span>
            </Switch>
          )}
          {config && (
            <span className="flex items-center gap-2 text-muted">
              <span
                aria-hidden="true"
                className={`size-[7px] rounded-full ${runningCount > 0 ? 'bg-running' : 'bg-faint'}`}
              />
              <span>
                <span className={`font-semibold ${runningCount > 0 ? 'text-ink' : 'text-muted'}`}>
                  {runningCount}/{config.autoRunner.maxConcurrentRuns}
                </span>{' '}
                running
              </span>
            </span>
          )}
          {cost24h && (
            <span className="text-muted" title="Cost over the last 24 hours">
              <span className="font-data text-data font-semibold text-ink">{cost24h}</span> today
            </span>
          )}
          <div className="flex-1" />
          <button
            aria-label={THEME_LABELS[theme]}
            title={THEME_LABELS[theme]}
            className="inline-flex items-center justify-center rounded-md p-2 text-muted transition-colors duration-150 hover:bg-raised hover:text-ink"
            onClick={cycleTheme}
          >
            <Icon name={THEME_ICONS[theme]} />
          </button>
          <button
            aria-label="Log out"
            title="Log out"
            className="inline-flex items-center justify-center rounded-md p-2 text-muted transition-colors duration-150 hover:bg-raised hover:text-ink"
            onClick={() => fetch('/api/auth/logout', { method: 'POST' }).then(() => setAuthed(false))}
          >
            <Icon name="logout" />
          </button>
          <button onClick={() => setEditing('new')} className={btnPrimary}>
            New task
          </button>
        </header>

        {error && <div className="mx-6 mt-4 rounded-lg bg-fail-tint px-4 py-2 text-fail">{error}</div>}

        <main className="min-w-0 flex-1 px-6 py-5">
          {view === 'board' && (
            <Board tasks={taskList} loading={tasks === null} onEdit={setEditing} onOpen={setOpenTask} onChanged={refresh} />
          )}
          {view === 'table' && <TableView onOpen={setOpenTask} />}
          {view === 'stats' && <StatsPage />}
          {view === 'api' && <ApiPage />}
          {view === 'settings' && <SettingsPage onSaved={setConfig} />}
        </main>
      </div>

      {openTask && (
        <TaskDetail
          task={openTask}
          onEdit={setEditing}
          onChanged={refresh}
          onClose={() => setOpenTask(null)}
        />
      )}

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
