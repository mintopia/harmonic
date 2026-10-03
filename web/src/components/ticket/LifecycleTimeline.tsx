import { lifecycleTimelineRows, type LifecycleTimelineTone, type ReceiptPillTone } from '../../lifecycle-timeline-model.js';
import { eventCount } from '../../id-format.js';
import type { TicketTimelineEvent } from '../../types.js';
import { card, railSectionCount } from '../../ui.js';
import { FollowTail } from './FollowTail';

const CAPS = 'text-label font-bold uppercase tracking-caps text-faint';
const TAG = 'rounded-lg bg-raised px-1.5 py-px text-label font-bold uppercase tracking-caps-tight text-muted';
const PILL_SHAPE = 'whitespace-nowrap rounded-full px-2 py-0.5 text-label font-semibold uppercase leading-[1.2] tracking-caps-tight';

const DOT: Record<LifecycleTimelineTone, string> = {
  neutral: 'bg-edge',
  running: 'bg-running-dot motion-safe:animate-dot-pulse',
  passed: 'bg-merged-dot',
  failed: 'bg-fail-dot',
  awaiting: 'bg-await-dot',
  sent: 'bg-accent',
  received: 'bg-ready',
};

const PILL: Record<ReceiptPillTone, string> = {
  done: 'bg-done-tint text-done',
  ready: 'bg-ready-tint text-ready',
  paused: 'bg-paused-tint text-paused',
  fail: 'bg-fail-tint text-fail',
};

const WORD: Record<LifecycleTimelineTone, string> = {
  neutral: 'text-ink',
  running: 'text-running',
  passed: 'text-merged',
  failed: 'text-fail',
  awaiting: 'text-await',
  sent: 'text-accent',
  received: 'text-ready',
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
            <span className={railSectionCount}>{eventCount(events.length)}</span>
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
                  className="pt-0.5 text-right font-data text-micro leading-[1.35] tabular-nums text-faint"
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
                      <span className={TAG}>{row.tag}</span>
                    )}
                    {row.message && (
                      <>
                        <span className={`${PILL_SHAPE} bg-accent-tint text-accent`}>{row.message.peer}</span>
                        {row.message.epic && (
                          <span className={`${PILL_SHAPE} bg-await-tint text-await`}>{row.message.epic}</span>
                        )}
                        <span className={`${PILL_SHAPE} ${PILL[row.message.receipt.tone]}`}>{row.message.receipt.label}</span>
                      </>
                    )}
                  </div>
                  {row.message?.preview && (
                    <p className="mt-1.5 max-w-[68ch] break-words border-l-2 border-edge py-0.5 pl-2.5 text-small text-ink">{row.message.preview}</p>
                  )}
                  {(row.detail || row.message) && (
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-small text-muted">
                      {row.detail}
                      {row.detail && row.message ? ' · ' : ''}
                      {row.message && (
                        <a href={row.message.href} className="font-semibold text-accent no-underline hover:underline">
                          View Thread →
                        </a>
                      )}
                    </p>
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
