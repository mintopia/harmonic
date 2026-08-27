import { touchOverlay } from '../ui';

export interface TabDef {
  id: string;
  label: string;
}

/** An ARIA-correct tab strip (`role="tablist"`/`role="tab"`/`aria-selected`) in
 * Paper's underline style — the same active border-accent / inactive muted
 * treatment ApiReference's PaneTab uses, promoted to a proper tablist so the
 * Settings shell is keyboard- and screen-reader-legible. Tab state lives with
 * the caller; this is presentational. Each tab points at its panel via
 * `aria-controls={settings-panel-<id>}`, which the caller sets on the panel. */
export function Tabs({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: readonly TabDef[];
  active: string;
  onChange: (id: string) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-x-5 gap-y-1 border-b border-hairline">
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`settings-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`settings-panel-${tab.id}`}
            onClick={() => onChange(tab.id)}
            className={`relative -mb-px border-b-2 px-1 pb-2 font-medium transition-colors duration-150 ${
              selected ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {tab.label}
            <span aria-hidden="true" className={touchOverlay} />
          </button>
        );
      })}
    </div>
  );
}
