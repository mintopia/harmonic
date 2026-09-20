import { BrandMark } from './BrandMark';
import { Icon } from './Icon';
import { NavRail } from './NavRail';
import { OperatorControls, type OperatorControlsProps } from './OperatorControls';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import type { Workspace } from '../types';
import type { View } from '../rail-model';
import type { Scope } from '../router-model';

interface AppSidebarProps {
  railCollapsed: boolean;
  railDesktop: boolean;
  menuOpen: boolean;
  onClose: () => void;
  instanceName: string;
  workspaces: Workspace[];
  activeWorkspaceId: number | null;
  onSwitch: (id: number) => void;
  onGlobal: () => void;
  onCreated: (workspace: Workspace) => void;
  view: View;
  scope: Scope;
  needsYouCount: number;
  onPickView: (v: View) => void;
  onToggleRail: () => void;
  /** Forwarded as-is to the drawer-layout {@link OperatorControls}. */
  operatorControls: Omit<OperatorControlsProps, 'layout' | 'view'>;
}

export function AppSidebar({
  railCollapsed,
  railDesktop,
  menuOpen,
  onClose,
  instanceName,
  workspaces,
  activeWorkspaceId,
  onSwitch,
  onGlobal,
  onCreated,
  view,
  scope,
  needsYouCount,
  onPickView,
  onToggleRail,
  operatorControls,
}: AppSidebarProps) {
  return (
    <aside
      aria-label="Sidebar"
      aria-hidden={!menuOpen && !railDesktop}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      className={`z-50 bg-shell max-rail:fixed max-rail:inset-y-0 max-rail:left-0 max-rail:w-[280px] max-rail:max-w-[85%] max-rail:flex max-rail:flex-col max-rail:overflow-y-auto max-rail:border-r max-rail:border-hairline max-rail:shadow-float max-rail:transition-transform max-rail:duration-200 max-rail:ease-out motion-reduce:transition-none shrink-0 rail:flex rail:flex-col rail:overflow-hidden rail:border-r rail:border-hairline rail:transition-[width] rail:duration-150 rail:ease-out motion-reduce:rail:transition-none ${
        menuOpen ? 'max-rail:translate-x-0' : 'max-rail:invisible max-rail:-translate-x-full'
      } ${railCollapsed ? 'rail:w-12' : 'rail:w-[200px]'}`}
    >
      <div
        className={`flex items-center gap-2.5 px-4 py-3 rail:px-3 rail:pb-5 ${railCollapsed ? 'rail:justify-center rail:px-0' : ''}`}
      >
        <BrandMark />
        <span
          className={`whitespace-nowrap font-display text-title font-display-weight tracking-tight ${railCollapsed ? 'rail:hidden' : ''}`}
        >
          {instanceName}
        </span>
        {railCollapsed && <span className="sr-only">{instanceName}</span>}
        <button
          aria-label="Close menu"
          className="ml-auto inline-flex size-9 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-ink rail:hidden"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className={`px-4 pb-3 rail:px-3 ${railCollapsed ? 'rail:hidden' : ''}`}>
        <WorkspaceSwitcher
          workspaces={workspaces}
          activeId={activeWorkspaceId}
          onSwitch={onSwitch}
          onGlobal={onGlobal}
          onCreated={onCreated}
        />
      </div>
      <div
        className={`flex flex-col gap-0.5 overflow-y-auto border-t border-hairline p-2 rail:flex-1 rail:border-t-0 rail:pt-0 max-rail:overflow-visible ${
          railCollapsed ? 'rail:px-1.5' : ''
        }`}
      >
        <NavRail
          view={view}
          scope={scope}
          needsYouCount={needsYouCount}
          railCollapsed={railCollapsed}
          railDesktop={railDesktop}
          onPickView={onPickView}
          onToggleRail={onToggleRail}
        />
      </div>
      <div className="mt-auto rail:hidden">
        <OperatorControls layout="drawer" view={view} {...operatorControls} />
      </div>
    </aside>
  );
}
