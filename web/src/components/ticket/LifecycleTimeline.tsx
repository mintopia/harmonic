import { lifecycleTimelineRows, type LifecycleTimelineTone } from '../../lifecycle-timeline-model.js';
import type { TicketTimelineEvent } from '../../types.js';
import { sectionTitle } from '../../ui.js';

const DOT: Record<LifecycleTimelineTone, string> = {
  neutral: 'bg-edge',
  running: 'bg-running-dot motion-safe:animate-dot-pulse',
  passed: 'bg-merged-dot',
  failed: 'bg-fail-dot',
  awaiting: 'bg-await-dot',
};

const WORD: Record<LifecycleTimelineTone, string> = {
  neutral: 'text-muted',
  running: 'text-running',
  passed: 'text-merged',
  failed: 'text-fail',
  awaiting: 'text-await',
};

function timestamp(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Ticket-scoped audit trail. It deliberately has no selection controls: AttemptTimeline owns switching Runs. */
export function LifecycleTimeline({ events }: { events: TicketTimelineEvent[] }) {
  const rows = lifecycleTimelineRows(events);
  return (
    <section aria-labelledby="lifecycle-timeline-heading" className="mt-7 border-t border-hairline pt-5">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="lifecycle-timeline-heading" className={sectionTitle}>Lifecycle</h2>
        <p className="text-small text-faint">Chronological audit trail</p>
      </div>
      {rows.length === 0 ? (
        <p className="mt-3 text-small text-muted">Lifecycle events will appear here as this ticket progresses.</p>
      ) : (
        <ol aria-label="Chronological lifecycle timeline" className="mt-4 space-y-0">
          {rows.map((row) => (
            <li key={row.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 border-l border-hairline pb-4 pl-3 last:pb-0">
              <span role="img" aria-label={row.label} className={`-ml-[17px] mt-1 size-2 shrink-0 rounded-full ring-4 ring-canvas ${DOT[row.tone]}`} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className={`text-small font-semibold ${WORD[row.tone]}`}>{row.label}</span>
                  <time dateTime={new Date(row.at).toISOString()} className="text-[11.5px] tabular-nums text-faint">{timestamp(row.at)}</time>
                </div>
                {row.detail && <p className="mt-0.5 whitespace-pre-wrap break-words text-small text-muted">{row.detail}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
