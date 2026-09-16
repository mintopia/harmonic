import { Icon, type IconName } from './Icon';
import { Switch } from './Switch';
import type { AppConfig } from '../types';
import type { HostLoad } from '../ws';
import type { View } from '../rail-model';
import type { ThemePref } from '../theme';
import { touchTarget } from '../ui';

const DOCS_URL = 'https://mintopia.github.io/harmonic';

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

export interface OperatorControlsProps {
  layout: 'bar' | 'drawer';
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
  onLogout: () => void;
}

function RunningReadout({ config, runningCount }: { config: AppConfig; runningCount: number }) {
  return (
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
  );
}

/**
 * The header's secondary operator cluster — auto-runner, fleet pause, tracker
 * refresh, the cost/load/host readouts, and the app-chrome controls (help,
 * theme, logout). Rendered inline in the desktop status bar
 * (`layout="bar"`, the canonical strip) and stacked in the mobile nav drawer
 * (`layout="drawer"`), so both surfaces drive the same controls without drift.
 */
export function OperatorControls(props: OperatorControlsProps) {
  const {
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
    onLogout,
  } = props;
  const layout = props.layout;

  const pauseIcon = (
    <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      {globalPaused ? <path d="M7 5l12 7-12 7V5z" /> : <path d="M7 4h4v16H7V4zm6 0h4v16h-4V4z" />}
    </svg>
  );
  const pauseText = globalPausePending ? 'Updating…' : globalPaused ? 'Resume' : 'Pause';
  const showRefresh = view === 'board' && trackerEnabled;

  if (layout === 'drawer') {
    return (
      <div className="flex flex-col gap-1 border-t border-hairline px-3 py-3">
        <div className="px-1 pb-1 text-label font-bold uppercase tracking-[0.09em] text-faint">Fleet</div>
        {config && (
          <div className="flex min-h-11 items-center justify-between rounded-md px-2.5">
            <span className="text-body text-muted">
              Auto-runner <b className="font-semibold text-ink">{config.autoRunner.enabled ? 'on' : 'off'}</b>
            </span>
            <Switch checked={config.autoRunner.enabled} label="Auto-runner" onChange={onAutoRunnerChange} />
          </div>
        )}
        {globalPaused !== null && (
          <button
            type="button"
            aria-pressed={globalPaused}
            className={`flex min-h-11 items-center gap-2 rounded-md px-2.5 text-left font-medium transition-colors duration-150 disabled:opacity-60 ${
              globalPaused ? 'text-paused' : 'text-muted hover:bg-raised hover:text-ink'
            }`}
            disabled={globalPausePending}
            onClick={() => onGlobalPauseChange(!globalPaused)}
          >
            {pauseIcon}
            {globalPausePending ? 'Updating…' : globalPaused ? 'Resume fleet' : 'Pause fleet'}
          </button>
        )}
        {showRefresh && (
          <button
            type="button"
            className="flex min-h-11 items-center gap-2 rounded-md px-2.5 text-left font-medium text-muted transition-colors duration-150 hover:bg-raised hover:text-ink disabled:opacity-60"
            disabled={refreshingTracker}
            onClick={onRefreshTracker}
          >
            <Icon name="refresh" className={refreshingTracker ? 'motion-safe:animate-spin' : ''} />
            {refreshingTracker ? 'Refreshing…' : 'Refresh tickets'}
          </button>
        )}
        {config && (
          <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-2.5 border-t border-hairline px-2.5 pt-3 text-small">
            <div>
              <dt className="text-label font-bold uppercase tracking-[0.08em] text-faint">Running</dt>
              <dd className="mt-0.5 tabular-nums text-ink">
                {runningCount} / {config.autoRunner.maxConcurrentAttempts}
              </dd>
            </div>
            {cost24h && (
              <div>
                <dt className="text-label font-bold uppercase tracking-[0.08em] text-faint">Last 24h</dt>
                <dd className="mt-0.5 tabular-nums text-ink">{cost24h}</dd>
              </div>
            )}
            {hostLoad && (
              <div className="col-span-2">
                <dt className="text-label font-bold uppercase tracking-[0.08em] text-faint">Load · {hostLoad.cores} cores</dt>
                <dd className={`mt-0.5 tabular-nums ${hostLoad.saturated ? 'text-fail' : 'text-ink'}`}>
                  {hostLoad.load1.toFixed(2)} / {hostLoad.load5.toFixed(2)} / {hostLoad.load15.toFixed(2)}
                </dd>
              </div>
            )}
          </dl>
        )}
        <div className="mt-1 flex items-center gap-1 border-t border-hairline px-1 pt-2">
          <a
            aria-label="Documentation"
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={`${touchTarget} rounded-md text-muted transition-colors duration-150 hover:bg-raised hover:text-ink`}
          >
            <Icon name="help" />
          </a>
          <button
            aria-label={THEME_LABELS[theme]}
            className={`${touchTarget} rounded-md text-muted transition-colors duration-150 hover:bg-raised hover:text-ink`}
            onClick={onThemeCycle}
          >
            <Icon name={THEME_ICONS[theme]} />
          </button>
          {passwordSet && (
            <button
              aria-label="Log out"
              className={`${touchTarget} ml-auto rounded-md text-muted transition-colors duration-150 hover:bg-raised hover:text-ink`}
              onClick={onLogout}
            >
              <Icon name="logout" />
            </button>
          )}
        </div>
      </div>
    );
  }

  // layout === 'bar' — the canonical desktop status strip.
  return (
    <>
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
          {pauseIcon}
          {pauseText}
        </button>
      )}
      {config && <RunningReadout config={config} runningCount={runningCount} />}
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
      {showRefresh && (
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
      <a
        aria-label="Documentation"
        title="Documentation"
        href={DOCS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={`${touchTarget} rounded-md text-muted transition-colors duration-150 hover:bg-raised hover:text-ink`}
      >
        <Icon name="help" />
      </a>
      <button
        aria-label={THEME_LABELS[theme]}
        title={THEME_LABELS[theme]}
        className={`${touchTarget} rounded-md text-muted transition-colors duration-150 hover:bg-raised hover:text-ink`}
        onClick={onThemeCycle}
      >
        <Icon name={THEME_ICONS[theme]} />
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
    </>
  );
}
