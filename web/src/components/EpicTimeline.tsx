import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { TrackerRef } from '../types.js';
import type { Epic } from '../epic-model.js';
import { eventCount } from '../id-format.js';
import { epicTimelineRows } from '../epic-timeline-model.js';
import type { MergeStepTone } from '../merge-progress-model.js';
import { card, railSectionCount } from '../ui.js';
import { PromptSent } from './ticket/Description.js';

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

type RefreshPrompt = { locator: string; at: string };

function RefreshPromptItem({ workspaceId, epicRef, prompt }: { workspaceId: number; epicRef: TrackerRef; prompt: RefreshPrompt }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const load = () => {
    if (text !== null) return;
    api.epicRefreshPrompt(workspaceId, epicRef, prompt.locator).then(setText, () => setFailed(true));
  };
  const at = new Date(prompt.at).getTime();
  return (
    <details onToggle={(event) => event.currentTarget.open && load()} className="border-t border-hairline px-5 py-3">
      <summary className="cursor-pointer text-small font-semibold text-ink">
        Refresh resolver prompt · <time dateTime={prompt.at} className="font-data tabular-nums text-muted">{clockTime(at)}</time>
      </summary>
      {text !== null && <PromptSent prompt={text} label="Prompt sent" className="mt-3" />}
      {failed && <p className="mt-2 text-small text-muted">The archived prompt could not be read.</p>}
    </details>
  );
}

/** The epic refresh resolver's Resolved Prompts, read from the Archive on demand; absent when none were sent. */
function RefreshPrompts({ workspaceId, epicRef }: { workspaceId: number; epicRef: TrackerRef }) {
  const [prompts, setPrompts] = useState<RefreshPrompt[]>([]);
  useEffect(() => {
    let live = true;
    api.epicRefreshPrompts(workspaceId, epicRef).then(
      ({ prompts: list }) => live && setPrompts(list),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [workspaceId, epicRef]);
  if (prompts.length === 0) return null;
  return (
    <div aria-label="Epic refresh resolver prompts">
      {prompts.map((prompt) => (
        <RefreshPromptItem key={prompt.locator} workspaceId={workspaceId} epicRef={epicRef} prompt={prompt} />
      ))}
    </div>
  );
}

export function EpicTimeline({ epic, workspaceId }: { epic: Epic; workspaceId?: number }) {
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
            <li key={row.id} className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3">
              <time dateTime={new Date(row.at).toISOString()} className="pt-0.5 text-right font-data text-micro leading-[1.35] tabular-nums text-faint">
                {clockTime(row.at)}
              </time>
              <div className="relative border-l border-hairline pb-5 pl-5 last:pb-1">
                <span aria-hidden="true" className={`absolute -left-1 top-1 size-2 rounded-full ring-4 ring-surface ${DOT[row.tone]}`} />
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`text-small font-semibold ${WORD[row.tone]}`}>{row.label}</span>
                  <span className="rounded-lg bg-raised px-1.5 py-px text-label font-bold uppercase tracking-caps-tight text-muted">{row.tag}</span>
                </div>
                {row.detail && <p className="mt-0.5 whitespace-pre-wrap break-words text-small text-muted">{row.detail}</p>}
              </div>
            </li>
          ))}
        </ol>
        {workspaceId !== undefined && <RefreshPrompts workspaceId={workspaceId} epicRef={epic.ref} />}
      </div>
    </section>
  );
}
