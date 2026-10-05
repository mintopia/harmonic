import type { Epic } from '../epic-model.js';
import { eventCount } from '../id-format.js';
import { epicTimelineRows } from '../epic-timeline-model.js';
import type { MergeStepTone } from '../merge-progress-model.js';
import { card, railSectionCount } from '../ui.js';
import { ResolvedPromptInline } from './ticket/ResolvedPromptInline';

const CAPS = 'text-label font-bold uppercase tracking-caps text-faint';

const DOT: Record<MergeStepTone, string> = {
  neutral: 'bg-edge',
  running: 'bg-running-dot motion-safe:animate-dot-pulse',
  passed: 'bg-merged-dot',
  failed: 'bg-fail-dot',
  awaiting: 'bg-await-dot',
};

const WORD: Record<MergeStepTone, string> = {
  neutral: 'text-ink',
  running: 'text-running',
  passed: 'text-merged',
  failed: 'text-fail',
  awaiting: 'text-await',
};

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function EpicTimeline({ epic, workspaceId }: { epic: Epic; workspaceId: number }) {
  const rows = epicTimelineRows(epic);
  return (
    <section aria-labelledby="epic-timeline-heading" className="py-5">
      <h2 id="epic-timeline-heading" className="mb-4 text-title font-semibold text-ink">Timeline</h2>
      <div className={`${card} overflow-hidden`}>
        <div className="flex items-center justify-between gap-4 border-b border-hairline px-5 py-3">
          <div className="flex items-baseline gap-2.5">
            <span className={CAPS}>Lifecycle</span>
            <span className={railSectionCount}>{eventCount(rows.length)}</span>
          </div>
        </div>
        <ol className="px-5 py-4" aria-label="Chronological epic timeline">
          {rows.map((row) => (
            <li key={row.id} className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 max-md:grid-cols-1">
              <time dateTime={new Date(row.at).toISOString()} className="pt-0.5 text-right font-data max-md:pl-5 max-md:text-left text-micro leading-[1.35] tabular-nums text-faint">
                {clockTime(row.at)}
              </time>
              <div className="relative border-l border-hairline pb-5 pl-5 last:pb-1">
                <span aria-hidden="true" className={`absolute -left-1 top-1 size-2 rounded-full ring-4 ring-surface ${DOT[row.tone]}`} />
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`text-small font-semibold ${WORD[row.tone]}`}>{row.label}</span>
                  <span className="rounded-lg bg-raised px-1.5 py-px text-label font-bold uppercase tracking-caps-tight text-muted">{row.tag}</span>
                </div>
                {row.detail && <p className="mt-0.5 whitespace-pre-wrap break-words text-small text-muted">{row.detail}</p>}
                {row.prompt && (
                  <ResolvedPromptInline
                    owner={{ workspaceId, epicRef: epic.ref, attempt: row.prompt.attempt }}
                    locator={row.prompt.locator}
                    index={row.prompt.index}
                    label={row.label.replace(/ prompt sent$/, '')}
                    caption="Prompt"
                    className="mt-2"
                  />
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
