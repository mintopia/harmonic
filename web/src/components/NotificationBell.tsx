import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './Icon';
import { NotificationRow } from './NotificationRow';
import { DROPDOWN_LIMIT, badgeText, bellLabel, workspaceTagFor, type NotificationsState } from '../notifications-model';
import type { Notification, Workspace } from '../types';
import { btnQuiet } from '../ui';
import { useDismissable } from '../useDismissable';
import { useNow } from '../useNow';

const MENU_ITEMS = '[role="menuitem"]:not(:disabled)';

export function NotificationBell({
  state,
  workspaces,
  scopeWorkspace,
  active,
  ticketHref,
  onOpenNotification,
  onMarkAllRead,
  onViewAll,
}: {
  state: NotificationsState;
  workspaces: Workspace[];
  scopeWorkspace: Workspace | null;
  active: boolean;
  ticketHref: (n: Notification) => string | null;
  onOpenNotification: (n: Notification, navigate: boolean) => void;
  onMarkAllRead: () => void;
  onViewAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const now = useNow(open);

  useDismissable(open, wrap, (reason) => {
    setOpen(false);
    if (reason === 'escape') button.current?.focus();
  });

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>(MENU_ITEMS)?.focus();
  }, [open]);

  const onMenuKeyDown = (e: KeyboardEvent) => {
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>(MENU_ITEMS) ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const target = e.key === 'ArrowDown' ? items[(at + 1) % items.length] : e.key === 'ArrowUp' ? items[(at - 1 + items.length) % items.length] : e.key === 'Home' ? items[0] : e.key === 'End' ? items[items.length - 1] : undefined;
    if (!target) return;
    e.preventDefault();
    target.focus();
  };

  const badge = badgeText(state.unreadCount);
  const latest = state.items.slice(0, DROPDOWN_LIMIT);

  return (
    <span className="relative" ref={wrap}>
      <button
        ref={button}
        type="button"
        aria-label={bellLabel(state.unreadCount)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-current={active ? 'page' : undefined}
        onClick={() => setOpen((v) => !v)}
        className={`relative inline-flex size-11 shrink-0 items-center justify-center rounded-md transition-colors duration-150 ${
          open || active ? 'bg-accent-tint text-accent' : 'text-muted hover:bg-raised hover:text-ink'
        }`}
      >
        <Icon name="bell" />
        {badge && (
          <span
            aria-hidden="true"
            className="absolute top-1.5 right-[5px] h-4 min-w-4 rounded-full bg-fail-dot px-1 text-center text-[10px] leading-4 font-bold text-on-fail shadow-[0_0_0_2px_var(--color-shell)]"
          >
            {badge}
          </span>
        )}
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label="Notifications"
          onKeyDown={onMenuKeyDown}
          className="absolute top-14 -right-1 z-40 w-[420px] max-w-[calc(100vw-1rem)] flex max-h-[calc(100vh-80px)] flex-col overflow-hidden rounded-lg border border-hairline bg-surface shadow-float"
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-hairline py-3 pr-3.5 pl-4">
            <b className="text-title font-semibold text-ink">Notifications</b>
            {state.unreadCount > 0 && (
              <span className="rounded-full bg-fail-tint px-[7px] text-[11px] font-bold text-fail">{state.unreadCount} unread</span>
            )}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={onMarkAllRead}
              disabled={state.unreadCount === 0}
              className={`${btnQuiet} ml-auto min-h-8 gap-1.5 px-1.5 py-1 text-[12.5px] disabled:opacity-50`}
            >
              <Icon name="check" className="size-3.5" />
              Mark all read
            </button>
          </div>
          {latest.length === 0 ? (
            <p className="px-4 py-6 text-center text-muted">No Notifications yet.</p>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {latest.map((n) => (
                <NotificationRow
                  key={n.id}
                  notification={n}
                  workspace={workspaceTagFor(n, workspaces, scopeWorkspace)}
                  href={ticketHref(n)}
                  now={now}
                  menuItem
                  onOpen={(item, navigate) => {
                    if (navigate) setOpen(false);
                    onOpenNotification(item, navigate);
                  }}
                />
              ))}
            </div>
          )}
          <div className="flex shrink-0 items-center justify-between border-t border-hairline bg-sunken py-0.5 pr-2 pl-4">
            <span className="text-small text-faint">Latest {DROPDOWN_LIMIT} · {scopeWorkspace ? scopeWorkspace.name : 'all Workspaces'}</span>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setOpen(false);
                onViewAll();
              }}
              className="inline-flex min-h-10 items-center gap-1.5 font-semibold text-accent transition-colors duration-150 hover:text-accent-hot"
            >
              View all
              <Icon name="arrow-up-right" className="size-3" />
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
