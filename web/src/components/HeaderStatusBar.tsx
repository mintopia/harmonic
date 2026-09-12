import { Icon, type IconName } from './Icon';
import { Switch } from './Switch';
import type { AppConfig } from '../types';
import type { HostLoad } from '../ws';
import type { View } from '../rail-model';
import type { ThemePref } from '../theme';
import { btnPrimary, touchTarget } from '../ui';

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

interface HeaderStatusBarProps {
  config: AppConfig | null;
  runningCount: number;
  cost24h: string | null;
  hostLoad: HostLoad | null;
  theme: ThemePref;
  view: View;
  passwordSet: boolean;
  globalPaused: boolean | null;
  globalPausePending: boolean;
  trackerEnabled: boolean;
  refreshingTracker: boolean;
  onAutoRunnerChange: (enabled: boolean) => void;
  onGlobalPauseChange: (paused: boolean) => void;
  onRefreshTracker: () => void;
  onThemeCycle: () => void;
  onSettingsClick: () => void;
  onLogout: () => void;
  onNewTask: () => void;
  onHelpClick: () => void;
}

export function HeaderStatusBar({
  config,
  runningCount,
  cost24h,
  hostLoad,
  theme,
  view,
  passwordSet,
  globalPaused,
  globalPausePending,
  trackerEnabled,
  refreshingTracker,
  onAutoRunnerChange,
  onGlobalPauseChange,
  onRefreshTracker,
  onThemeCycle,
  onSettingsClick,
  onLogout,
  onNewTask,
  onHelpClick,
}: HeaderStatusBarProps) {
  return (
    <header
      aria-label="Status"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline bg-shell px-6 py-2.5 max-rail:gap-x-2 max-rail:px-4"
    >
      {config && (
        <Switch checked={config.autoRunner.enabled} label="Auto-runner" onChange={onAutoRunnerChange}>
          <span
            className="text-[13px] text-muted"
            title={`Host Ceiling: ${config.autoRunner.maxConcurrentAttempts}`}
          >
            Auto-runner <b className="font-semibold text-ink">{config.autoRunner.enabled ? 'on' : 'off'}</b>
          </span>
        </Switch>
      )}
      {globalPaused !== null && (
        <button
          type="button"
          aria-pressed={globalPaused}
          aria-label={globalPaused ? 'Resume fleet' : 'Pause fleet'}
          title={globalPaused ? 'Fleet paused — resume all execution' : 'Pause all execution'}
          className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] font-semibold transition-colors duration-150 disabled:opacity-60 ${
            globalPaused ? 'bg-paused-tint text-paused' : 'text-muted hover:bg-raised hover:text-ink'
          }`}
          disabled={globalPausePending}
          onClick={() => onGlobalPauseChange(!globalPaused)}
        >
          <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
            {globalPaused ? <path d="M7 5l12 7-12 7V5z" /> : <path d="M7 4h4v16H7V4zm6 0h4v16h-4V4z" />}
          </svg>
          {globalPausePending ? 'Updating…' : globalPaused ? 'Resume' : 'Pause'}
        </button>
      )}
      {config && (
        <span className="flex items-center gap-2 text-[13px] text-muted">
          <span
            aria-hidden="true"
            className={`size-[7px] rounded-full ${runningCount > 0 ? 'bg-running-dot motion-safe:animate-pulse' : 'bg-faint'}`}
          />
          <span>
            <b className={`font-semibold ${runningCount > 0 ? 'text-ink' : 'text-muted'}`}>{runningCount}</b> running
          </span>
          <span aria-hidden="true" className="text-faint">
            ·
          </span>
          <span title="Host worker slots in use / ceiling">
            <span className="tabular-nums">
              {runningCount}/{config.autoRunner.maxConcurrentAttempts}
            </span>{' '}
            host
          </span>
        </span>
      )}
      {cost24h && (
        <span className="text-[13px] text-muted" title="Cost over the last 24 hours">
          <span className="text-faint">last 24h</span>{' '}
          <b className="font-semibold tabular-nums text-ink">{cost24h}</b>
        </span>
      )}
      {hostLoad && (
        <span
          className="text-[13px] text-muted"
          title={`Load average (1/5/15 min) · ${hostLoad.cores} cores`}
        >
          <span className="text-faint">load</span>{' '}
          <b className={`font-semibold tabular-nums ${hostLoad.saturated ? 'text-fail' : 'text-ink'}`}>
            {hostLoad.load1.toFixed(2)} / {hostLoad.load5.toFixed(2)} / {hostLoad.load15.toFixed(2)}
          </b>
        </span>
      )}
      <div className="flex-1" />
      {view === 'board' && trackerEnabled && (
        <button
          type="button"
          title="Rescan the tracker and mirror ticket changes now"
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] font-medium text-muted transition-colors duration-150 hover:bg-raised hover:text-ink disabled:opacity-60"
          disabled={refreshingTracker}
          onClick={onRefreshTracker}
        >
          <Icon name="refresh" className={refreshingTracker ? 'motion-safe:animate-spin' : ''} />
          {refreshingTracker ? 'Refreshing…' : 'Refresh tickets'}
        </button>
      )}
      <button
        aria-label="Help"
        title="Help"
        className={`${touchTarget} rounded-md text-muted transition-colors duration-150 hover:bg-raised hover:text-ink`}
        onClick={onHelpClick}
      >
        <Icon name="help" />
      </button>
      <button
        aria-label={THEME_LABELS[theme]}
        title={THEME_LABELS[theme]}
        className={`${touchTarget} rounded-md text-muted transition-colors duration-150 hover:bg-raised hover:text-ink`}
        onClick={onThemeCycle}
      >
        <Icon name={THEME_ICONS[theme]} />
      </button>
      <button
        aria-label="Settings"
        aria-current={view === 'settings' ? 'page' : undefined}
        title="Settings"
        className={`${touchTarget} rounded-md transition-colors duration-150 ${
          view === 'settings' ? 'bg-accent-tint text-accent' : 'text-muted hover:bg-raised hover:text-ink'
        }`}
        onClick={onSettingsClick}
      >
        <Icon name="settings" />
      </button>
      {passwordSet && (
        <button
          aria-label="Log out"
          title="Log out"
          className={`${touchTarget} rounded-md text-muted transition-colors duration-150 hover:bg-raised hover:text-ink`}
          onClick={onLogout}
        >
          <Icon name="logout" />
        </button>
      )}
      <button
        onClick={onNewTask}
        className={`${btnPrimary} gap-1.5 ${view === 'conversations' ? 'max-md:hidden' : ''}`}
      >
        <Icon name="plus" className="size-3.5" />
        New task
      </button>
    </header>
  );
}
