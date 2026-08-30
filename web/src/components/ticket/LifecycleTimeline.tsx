import { lifecycleTimelineRows, type LifecycleTimelineTone } from '../../lifecycle-timeline-model.js';
import type { TicketTimelineEvent } from '../../types.js';
import { card, railSectionCount } from '../../ui.js';
import { FollowTail } from './FollowTail';

const CAPS = 'text-label font-bold uppercase tracking-[0.1em] text-faint';

const DOT: Record<LifecycleTimelineTone, string> = {
  neutral: 'bg-edge',
  running: 'bg-running-dot motion-safe:animate-dot-pulse',
  passed: 'bg-merged-dot',
  failed: 'bg-fail-dot',
  awaiting: 'bg-await-dot',
};

const WORD: Record<LifecycleTimelineTone, string> = {
  neutral: 'text-ink',
  running: 'text-running',
  passed: 'text-merged',
  failed: 'text-fail',
  awaiting: 'text-await',
};

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/**
 * Ticket-scoped audit trail: a `Lifecycle` card whose header carries the event
 * count and the follow/tail control, over a time gutter and state-coloured nodes
 * threaded by a continuous connector rail. Each row can carry a source badge
 * (GITHUB / RUNNING / VERIFY / CRITIC). Navigation is the sidebar's; the only
 * control here is the tail, which pins the view to the live edge.
 */
export function LifecycleTimeline({
  events,
  following,
  onToggleFollow,
}: {
  events: TicketTimelineEvent[];
  following: boolean;
  onToggleFollow: () => void;
}) {
  const rows = lifecycleTimelineRows(events);
  return (
    <section aria-labelledby="lifecycle-timeline-heading" className="py-5">
      <h2 id="lifecycle-timeline-heading" className="mb-4 text-title font-semibold text-ink">
        Timeline
      </h2>
      <div className={`${card} overflow-hidden`}>
        <div className="flex items-center justify-between gap-4 border-b border-hairline px-5 py-3">
          <div className="flex items-baseline gap-2.5">
            <span className={CAPS}>Lifecycle</span>
            <span className={railSectionCount}>{events.length} events</span>
          </div>
          <FollowTail following={following} onToggle={onToggleFollow} />
        </div>
        {rows.length === 0 ? (
          <p className="px-5 py-6 text-small text-muted">Lifecycle events will appear here as this ticket progresses.</p>
        ) : (
          <ol className="px-5 py-4" aria-label="Chronological lifecycle timeline">
            {rows.map((row) => (
              <li key={row.id} className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3">
                <time
                  dateTime={new Date(row.at).toISOString()}
                  className="pt-0.5 text-right font-data text-[11px] leading-[1.35] tabular-nums text-faint"
                >
                  {clockTime(row.at)}
                </time>
                <div className="relative border-l border-hairline pb-5 pl-5 last:pb-1">
                  <span
                    role="img"
                    aria-label={row.label}
                    className={`absolute -left-1 top-1 size-2 rounded-full ring-4 ring-surface ${DOT[row.tone]}`}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-small font-semibold ${WORD[row.tone]}`}>{row.label}</span>
                    {row.tag && (
                      <span className="rounded-[4px] bg-raised px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.05em] text-muted">
                        {row.tag}
                      </span>
                    )}
                  </div>
                  {row.detail && (
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-small text-muted">{row.detail}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
