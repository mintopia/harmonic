import { useState } from 'react';
import { Icon } from './Icon';
import { NotificationRow } from './NotificationRow';
import { Switch } from './Switch';
import {
  SEVERITY_FILTERS,
  filterNotifications,
  RETENTION_NOTE,
  groupByDay,
  workspaceTagFor,
  severityCounts,
  type NotificationFilters,
  type NotificationsState,
  type SeverityFilter,
} from '../notifications-model';
import type { Notification, Workspace } from '../types';
import { btnGhost, displayTitle, labelType } from '../ui';
import { useNow } from '../useNow';

export function NotificationsPage({
  state,
  allRetainedLoaded,
  workspaces,
  scopeWorkspace,
  ticketHref,
  onOpenNotification,
  onMarkAllRead,
}: {
  state: NotificationsState;
  allRetainedLoaded: boolean;
  workspaces: Workspace[];
  scopeWorkspace: Workspace | null;
  ticketHref: (n: Notification) => string | null;
  onOpenNotification: (n: Notification, navigate: boolean) => void;
  onMarkAllRead: () => void;
}) {
  const [severity, setSeverity] = useState<SeverityFilter>('all');
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const now = useNow(true);

  const filters: NotificationFilters = { severity, workspaceId: scopeWorkspace ? null : workspaceId, unreadOnly };
  const counts = severityCounts(filterNotifications(state.items, { ...filters, severity: 'all', unreadOnly: false }));
  const groups = groupByDay(filterNotifications(state.items, filters), now);

  return (
    <div className="-mx-6 -mt-5 -mb-16 max-w-[980px] px-[30px] pt-7 pb-10">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div>
          <h1 className={displayTitle}>Notifications</h1>
          <p className="mt-1 text-[13px] text-muted">
            {scopeWorkspace ? `Workspace ${scopeWorkspace.name}` : 'Across all Workspaces'} · {state.unreadCount} unread
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={onMarkAllRead} disabled={state.unreadCount === 0} className={`${btnGhost} gap-1.5`}>
            <Icon name="check" className="size-3.5" />
            Mark all read
          </button>
        </div>
      </div>

      <div className="mt-[22px] mb-1 flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <div role="group" aria-label="Severity" className="inline-flex overflow-hidden rounded-sm border border-edge bg-surface">
          {SEVERITY_FILTERS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              aria-pressed={severity === value}
              onClick={() => setSeverity(value)}
              className={`inline-flex min-h-11 items-center gap-1.5 border-r border-hairline px-3 text-[12.5px] last:border-r-0 ${
                severity === value ? 'bg-accent-tint font-semibold text-accent' : 'font-medium text-muted hover:text-ink'
              }`}
            >
              {label}
              <span className="text-[11px] opacity-80">{counts[value]}</span>
            </button>
          ))}
        </div>
        {!scopeWorkspace && (
          <label className="inline-flex min-h-11 items-center gap-2 rounded-sm border border-edge bg-surface px-2.5 text-[12.5px] font-medium">
            <span className={`${labelType} text-muted`}>Workspace</span>
            <select
              value={workspaceId ?? 'all'}
              onChange={(e) => setWorkspaceId(e.target.value === 'all' ? null : Number(e.target.value))}
              className="hm-select border-0 bg-transparent px-1 font-semibold text-ink"
            >
              <option value="all">All Workspaces</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </label>
        )}
        <span className="ml-auto inline-flex min-h-11 items-center">
          <Switch checked={unreadOnly} onChange={setUnreadOnly}>
            <span className="text-small">Unread only</span>
          </Switch>
        </span>
      </div>

      {groups.map((group) => (
        <section key={group.label} className="mt-[22px]">
          <h2 className="mx-0.5 mb-2 text-label font-bold uppercase tracking-[0.1em] text-faint">{group.label}</h2>
          <div className="overflow-hidden rounded-lg bg-surface shadow-card">
            {group.items.map((n) => (
              <NotificationRow key={n.id} notification={n} workspace={workspaceTagFor(n, workspaces, scopeWorkspace)} href={ticketHref(n)} now={now} page onOpen={onOpenNotification} />
            ))}
          </div>
        </section>
      ))}
      {groups.length === 0 && (
        <div className="mt-[22px] rounded-lg bg-surface p-7 text-center text-muted shadow-card">
          {state.items.length === 0 && allRetainedLoaded ? 'No Notifications yet.' : 'No Notifications match these filters.'}
        </div>
      )}
      <div className="mt-[22px] flex justify-between text-small text-faint">
        <span>{RETENTION_NOTE}</span>
        {allRetainedLoaded && <span>End of list</span>}
      </div>
    </div>
  );
}
