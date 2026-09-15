import { Icon } from './Icon';
import type { AppConfig } from '../types';
import type { HostLoad } from '../ws';
import type { View } from '../rail-model';
import type { ThemePref } from '../theme';
import { btnPrimary } from '../ui';
import { OperatorControls } from './OperatorControls';

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
  menuOpen: boolean;
  onMenuToggle: () => void;
  onAutoRunnerChange: (enabled: boolean) => void;
  onGlobalPauseChange: (paused: boolean) => void;
  onRefreshTracker: () => void;
  onThemeCycle: () => void;
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
  menuOpen,
  onMenuToggle,
  onAutoRunnerChange,
  onGlobalPauseChange,
  onRefreshTracker,
  onThemeCycle,
  onLogout,
  onNewTask,
  onHelpClick,
}: HeaderStatusBarProps) {
  return (
    <header
      aria-label="Status"
      className="flex shrink-0 items-center gap-x-3 gap-y-2 border-b border-hairline bg-shell px-6 py-2.5 rail:flex-wrap max-rail:gap-x-2 max-rail:px-4"
    >
      <button
        type="button"
        aria-label="Menu"
        aria-expanded={menuOpen}
        className="-ml-1.5 inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-raised hover:text-ink rail:hidden"
        onClick={onMenuToggle}
      >
        <Icon name="menu" />
      </button>
      {config && (
        <span className="flex items-center gap-2 text-small text-muted rail:hidden">
          <span
            aria-hidden="true"
            className={`size-[7px] rounded-full ${runningCount > 0 ? 'bg-running-dot motion-safe:animate-pulse' : 'bg-faint'}`}
          />
          <b className={`font-semibold ${runningCount > 0 ? 'text-ink' : 'text-muted'}`}>{runningCount}</b> running
        </span>
      )}
      <div className="hidden rail:contents">
        <OperatorControls
          layout="bar"
          config={config}
          runningCount={runningCount}
          cost24h={cost24h}
          hostLoad={hostLoad}
          theme={theme}
          view={view}
          passwordSet={passwordSet}
          globalPaused={globalPaused}
          globalPausePending={globalPausePending}
          trackerEnabled={trackerEnabled}
          refreshingTracker={refreshingTracker}
          onAutoRunnerChange={onAutoRunnerChange}
          onGlobalPauseChange={onGlobalPauseChange}
          onRefreshTracker={onRefreshTracker}
          onThemeCycle={onThemeCycle}
          onLogout={onLogout}
          onHelpClick={onHelpClick}
        />
      </div>
      <div className="flex-1 rail:hidden" />
      <button
        onClick={onNewTask}
        className={`${btnPrimary} shrink-0 gap-1.5 ${view === 'conversations' ? 'max-md:hidden' : ''}`}
      >
        <Icon name="plus" className="size-3.5" />
        New task
      </button>
    </header>
  );
}
