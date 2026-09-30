import type { MouseEvent, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { WorkspaceDot } from './WorkspaceDot';
import { SEVERITY_META, formatNotificationTime } from '../notifications-model';
import type { Notification, NotificationSeverity, Workspace } from '../types';

const SEVERITY_STYLE: Record<NotificationSeverity, { icon: IconName; tone: string }> = {
  failure: { icon: 'x-circle', tone: 'bg-fail-tint text-fail' },
  escalation: { icon: 'escalate', tone: 'bg-await-tint text-await' },
  merge: { icon: 'merge', tone: 'bg-merged-tint text-merged' },
  export: { icon: 'download', tone: 'bg-running-tint text-running' },
};

const UNREAD_BG =
  'bg-[color-mix(in_srgb,var(--color-accent-tint)_22%,var(--color-surface))] hover:bg-[color-mix(in_srgb,var(--color-accent-tint)_42%,var(--color-surface))]';

const isPlainLeftClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

export function NotificationRow({
  notification: n,
  workspace,
  href,
  now,
  page,
  menuItem,
  onOpen,
}: {
  notification: Notification;
  workspace: Workspace | null;
  href: string | null;
  now: number;
  page?: boolean;
  menuItem?: boolean;
  onOpen: (n: Notification, navigate: boolean) => void;
}) {
  const sev = SEVERITY_STYLE[n.severity];
  const className = `relative flex w-full items-start gap-3 border-b border-hairline text-left text-ink last:border-b-0 ${
    page ? 'px-4 py-[13px]' : 'py-[11px] pr-3.5 pl-4'
  } ${n.read ? 'hover:bg-raised' : UNREAD_BG}`;
  const content: ReactNode = (
    <>
      {!n.read && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-accent" />}
      <span className={`mt-px grid size-6 shrink-0 place-items-center rounded-sm ${sev.tone}`}>
        <Icon name={sev.icon} className="size-3.5" />
        <span className="sr-only">{SEVERITY_META[n.severity].label}</span>
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block leading-[1.4] ${page ? 'text-[13.5px]' : 'text-[13px]'} ${n.read ? 'font-[450] text-muted' : 'font-[650]'}`}>
          {n.title}
        </span>
        <span className="mt-[3px] flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-faint">
          {workspace && (
            <span className="inline-flex items-center gap-[5px] font-semibold text-muted">
              <WorkspaceDot workspace={workspace} />
              {workspace.name}
            </span>
          )}
          {n.taskId !== null && <span>Ticket #{n.taskId}</span>}
          {page && n.detail && (
            <>
              {n.taskId !== null && <span aria-hidden="true">·</span>}
              <span className="min-w-0 text-muted">{n.detail}</span>
            </>
          )}
        </span>
      </span>
      <span className={`shrink-0 whitespace-nowrap pt-0.5 text-[11.5px] ${n.read ? 'text-faint' : 'font-semibold text-accent'}`}>
        {formatNotificationTime(n.createdAt, now)}
      </span>
      <span aria-hidden={n.read ? true : undefined} className={`mt-[7px] size-2 shrink-0 rounded-full ${n.read ? 'bg-transparent' : 'bg-accent'}`}>
        {!n.read && <span className="sr-only">Unread</span>}
      </span>
    </>
  );
  const role = menuItem ? 'menuitem' : undefined;
  const tabIndex = menuItem ? -1 : undefined;
  if (href === null) {
    return (
      <button type="button" role={role} tabIndex={tabIndex} className={className} onClick={() => onOpen(n, false)}>
        {content}
      </button>
    );
  }
  return (
    <a
      href={href}
      role={role}
      tabIndex={tabIndex}
      className={className}
      onClick={(e) => {
        const plain = isPlainLeftClick(e);
        if (plain) e.preventDefault();
        onOpen(n, plain);
      }}
    >
      {content}
    </a>
  );
}
