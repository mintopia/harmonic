import type { Attempt } from '../../types';
import { harnessLabel, type ContentSelection } from '../../task-detail-model';
import { attemptTone } from '../../attempt-timeline-model';
import { publishWord } from '../../attempt-rail-model';
import { railSectionHead, railSectionCount, railNavButton, railNavSelected, railNavIdle, codeChip } from '../../ui';
import { formatCost } from '../../cost';
import { Icon } from '../Icon';
import { formatModelLabel } from '../TaskIdentity';
import { NAV_DOT, NAV_WORD } from './shared';

export function AttemptsNav({
  attempts,
  selectedNumber,
  onSelect,
}: {
  attempts: Attempt[];
  selectedNumber: number | null;
  onSelect: (attempt: Attempt) => void;
}) {
  return (
    <section className="border-b border-hairline px-3.5 py-3.5" aria-label="Attempt history">
      <div className={railSectionHead}>
        Attempts <span className={railSectionCount}>{attempts.length}</span>
      </div>
      {attempts.length === 0 ? (
        <p className="text-small text-muted">This ticket hasn't been attempted yet.</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {attempts.map((attempt, index) => {
            const previous = attempts[index - 1];
            const harnessChanged = !!previous?.harness && !!attempt.harness && previous.harness !== attempt.harness;
            const tone = attemptTone(attempt.state);
            const selected = attempt.number === selectedNumber;
            return (
              <li key={attempt.id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelect(attempt)}
                  className={`${railNavButton} flex-wrap ${selected ? railNavSelected : railNavIdle}`}
                >
                  <span role="img" aria-label={attempt.state} className={`size-2 shrink-0 rounded-full ${NAV_DOT[tone]}`} />
                  <span className="text-data font-semibold text-ink">Attempt {attempt.number}</span>
                  <span className={`ml-auto text-label font-bold uppercase tracking-[0.03em] ${selected && tone === 'failed' ? 'text-ink' : NAV_WORD[tone]}`}>{attemptWord(attempt)}</span>
                  <AttemptRoute attempt={attempt} harnessChanged={harnessChanged} />
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function attemptWord(attempt: Attempt): string {
  if (attempt.state === 'running') return attempt.stepRuns.findLast((step) => step.state === 'running')?.stepId ?? 'running';
  return attempt.state === 'passed' ? publishWord(attempt.stepRuns) : attempt.state;
}

function AttemptRoute({ attempt, harnessChanged }: { attempt: Attempt; harnessChanged: boolean }) {
  const { classifier } = attempt;
  if (!attempt.harness && !classifier) return null;
  return (
    <span className="block basis-full pl-[18px] text-small text-muted">
      {attempt.harness && (
        <span className="block">
          {harnessLabel(attempt.harness)} · {formatModelLabel(attempt.model ?? '')}
          {classifier?.optionId && <code className={`${codeChip} ml-1.5 bg-tool-tint text-tool`}>{classifier.optionId}</code>}
        </span>
      )}
      {harnessChanged && <span className="block text-accent">Harness changed: cold Session</span>}
      {classifier?.kind === 'routed' && classifier.reason && <span className="block">Classifier: {classifier.reason}</span>}
      {attempt.routing && <span className="block">Routing {formatCost(attempt.routing.cost) ?? 'cost unavailable'}</span>}
      {classifier?.kind === 'abstained' && <span className="block">Classifier abstained{classifier.reason ? `: ${classifier.reason}` : ''}</span>}
    </span>
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
