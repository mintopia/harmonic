import { lifecycleTimelineRows, type LifecycleTimelineTone } from '../../lifecycle-timeline-model.js';
import type { TicketTimelineEvent } from '../../types.js';
import { sectionTitle } from '../../ui.js';
import { FollowTail } from './FollowTail';

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

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function calendarDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Ticket-scoped audit trail: a time gutter, state-coloured nodes threaded by a
 * continuous connector rail, and a sticky header bar carrying the follow/tail
 * control. It has no selection controls — the sidebar owns navigation; the only
 * control here is the tail, which pins the view to the auto-updating live edge.
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
    <section aria-labelledby="lifecycle-timeline-heading" className="pt-2">
      <div className="sticky top-0 z-10 -mx-[30px] mb-4 flex items-center justify-between gap-4 border-b border-hairline bg-canvas px-[30px] py-3">
        <div className="flex items-baseline gap-3">
          <h2 id="lifecycle-timeline-heading" className={sectionTitle}>
            Timeline
          </h2>
          <p className="text-small text-faint">Chronological audit trail</p>
        </div>
        <FollowTail following={following} onToggle={onToggleFollow} />
      </div>
      {rows.length === 0 ? (
        <p className="text-small text-muted">Lifecycle events will appear here as this ticket progresses.</p>
      ) : (
        <ol aria-label="Chronological lifecycle timeline">
          {rows.map((row) => (
            <li key={row.id} className="grid grid-cols-[54px_minmax(0,1fr)] gap-x-3">
              <time
                dateTime={new Date(row.at).toISOString()}
                className="pt-0.5 text-right text-[11px] leading-[1.35] tabular-nums"
              >
                <span className="block text-muted">{clockTime(row.at)}</span>
                <span className="block text-faint">{calendarDate(row.at)}</span>
              </time>
              <div className="relative border-l border-hairline pb-5 pl-5 last:pb-1">
                <span
                  role="img"
                  aria-label={row.label}
                  className={`absolute -left-1 top-1 size-2 rounded-full ring-4 ring-canvas ${DOT[row.tone]}`}
                />
                <span className={`text-small font-semibold ${WORD[row.tone]}`}>{row.label}</span>
                {row.detail && (
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-small text-muted">{row.detail}</p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
