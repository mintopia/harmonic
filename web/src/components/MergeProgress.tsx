import { useState } from 'react';
import { mergeStepRows, type MergeStepEvent, type MergeStepTone } from '../merge-progress-model.js';

const CAPS = 'text-label font-bold uppercase tracking-[0.1em] text-faint';

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

/**
 * The step log of a single merge — started → (conflicts → resolve turns) →
 * post-merge check → merged/reverted/escalated — as a compact node-threaded
 * timeline. A step that carries more (conflict paths, the escalation reason)
 * expands in place to reveal it. Shared by the Task-detail merge surface and the
 * Epic integration bar so both read the same server-recorded steps.
 */
export function MergeProgress({ steps, label = 'Merge' }: { steps: readonly MergeStepEvent[]; label?: string }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (steps.length === 0) return null;
  const rows = mergeStepRows(steps);
  return (
    <section aria-label={`${label} progress`}>
      <div className={`${CAPS} mb-2`}>{label}</div>
      <ol className="flex flex-col">
        {rows.map((row) => {
          const expandable = row.log !== null;
          const isOpen = open[row.key] ?? false;
          return (
            <li key={row.key} className="relative border-l border-hairline pb-3 pl-4 last:pb-0">
              <span
                role="img"
                aria-label={row.label}
                className={`absolute -left-1 top-1 size-2 rounded-full ring-4 ring-surface ${DOT[row.tone]}`}
              />
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                {expandable ? (
                  <button
                    type="button"
                    onClick={() => setOpen((prev) => ({ ...prev, [row.key]: !isOpen }))}
                    aria-expanded={isOpen}
                    className={`text-small font-semibold ${WORD[row.tone]} hover:underline`}
                  >
                    <span aria-hidden="true" className="mr-1 inline-block text-faint">{isOpen ? '▾' : '▸'}</span>
                    {row.label}
                  </button>
                ) : (
                  <span className={`text-small font-semibold ${WORD[row.tone]}`}>{row.label}</span>
                )}
                {row.detail && <span className="font-data text-[11px] tabular-nums text-muted">{row.detail}</span>}
              </div>
              {expandable && isOpen && (
                <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-[4px] bg-raised px-2.5 py-2 text-[11px] leading-[1.4] text-muted">
                  {row.log}
                </pre>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
