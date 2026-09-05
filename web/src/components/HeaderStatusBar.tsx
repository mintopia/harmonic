import { Icon, type IconName } from './Icon';
import { Switch } from './Switch';
import type { AppConfig } from '../types';
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
  theme: ThemePref;
  view: View;
  passwordSet: boolean;
  onAutoRunnerChange: (enabled: boolean) => void;
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
  theme,
  view,
  passwordSet,
  onAutoRunnerChange,
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
      <div className="flex-1" />
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
      <button onClick={onNewTask} className={`${btnPrimary} gap-1.5`}>
        <Icon name="plus" className="size-3.5" />
        New task
      </button>
    </header>
  );
}
