import { Icon } from './Icon';
import { RAIL_GROUPS, VIEW_LABELS, type View } from '../rail-model';
import { railBadge, sectionLabel } from '../ui';

const railItem = (active: boolean, collapsed: boolean) =>
  `flex w-full min-h-11 items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-md px-2.5 py-2 text-left transition-colors duration-150 ${
    collapsed ? 'rail:justify-center rail:px-0' : ''
  } ${active ? 'bg-accent-tint font-semibold text-accent' : 'font-medium text-muted hover:bg-raised hover:text-ink'}`;

interface NavRailProps {
  view: View;
  needsYouCount: number;
  railCollapsed: boolean;
  railDesktop: boolean;
  onPickView: (v: View) => void;
  onToggleRail: () => void;
}

export function NavRail({ view, needsYouCount, railCollapsed, railDesktop, onPickView, onToggleRail }: NavRailProps) {
  // Collapsed items keep their accessible name and gain a native tooltip;
  // when the label is visible neither is needed — below the breakpoint the
  // drawer shows labels, so the attributes must not apply there.
  // Collapsed, the icon-only button has no visible text, so it needs an
  // aria-label/title. Fold the Deck's "Needs you" count into the label there:
  // the visual pill is suppressed at 48px, but a screen-reader operator — for
  // whom the collapsed rail is the whole nav — still hears the attention count.
  const railItemName = (label: string, needsYou: number | null = null) =>
    railCollapsed && railDesktop
      ? { 'aria-label': needsYou !== null ? `${label}, ${needsYou} needs you` : label, title: label }
      : {};

  // Hidden, not unmounted, when collapsed: keyboard order and focus
  // behavior stay identical in both widths.
  const railLabel = railCollapsed ? 'rail:hidden' : '';

  return (
    <>
      <nav aria-label="Views" className="flex flex-col gap-0.5 rail:flex-1">
        {RAIL_GROUPS.map((group) => {
          const groupId = `rail-group-${group.label.toLowerCase()}`;
          return (
            <div key={group.label} role="group" aria-labelledby={groupId} className="flex flex-col gap-0.5">
              <div
                id={groupId}
                className={`${sectionLabel} px-2.5 pb-1 ${group.label === 'Instance' ? 'sr-only' : ''} ${railCollapsed ? 'rail:hidden' : ''}`}
              >
                {group.label}
              </div>
              {group.views.map((v) => {
                const needsYou = v === 'board' && needsYouCount > 0 ? needsYouCount : null;
                return (
                  <button
                    key={v}
                    aria-current={view === v ? 'page' : undefined}
                    {...railItemName(VIEW_LABELS[v], needsYou)}
                    className={railItem(view === v, railCollapsed)}
                    onClick={() => onPickView(v)}
                  >
                    <Icon name={v} />
                    <span className={railLabel}>{VIEW_LABELS[v]}</span>
                    {needsYou !== null && (
                      <span
                        aria-label={`${needsYou} needs you`}
                        className={`${railBadge} ${railCollapsed ? 'rail:hidden' : ''}`}
                      >
                        {needsYou}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>
      <div className="mt-2 hidden border-t border-hairline pt-2 rail:flex rail:flex-col">
        <button
          aria-expanded={!railCollapsed}
          aria-label={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={railItem(false, railCollapsed)}
          onClick={onToggleRail}
        >
          <Icon className={railCollapsed ? '-scale-x-100' : ''} name="chevrons-left" />
          <span className={railLabel}>Collapse</span>
        </button>
      </div>
    </>
  );
}
