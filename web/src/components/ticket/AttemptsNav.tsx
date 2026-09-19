import type { Attempt } from '../../types';
import type { ContentSelection } from '../../task-detail-model';
import { attemptTone } from '../../attempt-timeline-model';
import { railSectionHead, railSectionCount, railNavButton, railNavSelected, railNavIdle } from '../../ui';
import { Icon } from '../Icon';
import { NAV_DOT, NAV_WORD } from './shared';

export function AttemptsNav({
  attempts,
  maxAttempts,
  selectedNumber,
  onSelect,
}: {
  attempts: Attempt[];
  maxAttempts: number | null;
  selectedNumber: number | null;
  onSelect: (attempt: Attempt) => void;
}) {
  return (
    <section className="border-b border-hairline px-3.5 py-3.5" aria-label="Attempt history">
      <div className={railSectionHead}>
        Attempts <span className={railSectionCount}>{attempts.length}{maxAttempts !== null && ` / ${maxAttempts}`}</span>
      </div>
      {attempts.length === 0 ? (
        <p className="text-small text-muted">This ticket hasn't been attempted yet.</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {attempts.map((attempt) => {
            const tone = attemptTone(attempt.state);
            const selected = attempt.number === selectedNumber;
            return (
              <li key={attempt.id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelect(attempt)}
                  className={`${railNavButton} ${selected ? railNavSelected : railNavIdle}`}
                >
                  <span role="img" aria-label={attempt.state} className={`size-2 shrink-0 rounded-full ${NAV_DOT[tone]}`} />
                  <span className="text-data font-semibold text-ink">Attempt {attempt.number}</span>
                  <span className={`ml-auto text-label font-bold uppercase tracking-[0.03em] ${NAV_WORD[tone]}`}>{attempt.state}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** The whole-Task panels: Stats and the lifecycle Timeline. */
export function PanelNav({ selected, onSelect }: { selected: 'stats' | 'timeline' | null; onSelect: (s: ContentSelection) => void }) {
  const entries = [
    { kind: 'stats', label: 'Stats', icon: 'stats' },
    { kind: 'timeline', label: 'Timeline', icon: 'activity' },
  ] as const;
  return (
    <section className="flex flex-col gap-1 border-b border-hairline px-3.5 py-3.5">
      {entries.map((entry) => (
        <button
          key={entry.kind}
          type="button"
          aria-pressed={selected === entry.kind}
          onClick={() => onSelect({ kind: entry.kind })}
          className={`${railNavButton} ${selected === entry.kind ? railNavSelected : railNavIdle}`}
        >
          <Icon name={entry.icon} className="size-3.5 shrink-0 text-muted" />
          <span className="text-data font-semibold text-ink">{entry.label}</span>
        </button>
      ))}
    </section>
  );
}
