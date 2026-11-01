import { useMemo, useState } from 'react';
import { PROMPT_FILTERS, filterByView, filterCounts, filterPrompts, libraryCounts, usedByLabel, type PromptFilter } from '../../prompt-library-model';
import { btnGhost, btnPrimary, labelType, searchField } from '../../ui';
import { EmptyState } from '../EmptyState';
import { Icon } from '../Icon';
import { LoadError } from '../LoadError';
import { usePromptsFlow } from './PromptsFlow';
import { SourceBadge } from './SourceBadge';

const INC_CHIP = 'rounded-sm bg-tool-tint px-1 font-data text-tool';

function SourceStrip({ bundled, yours }: { bundled: number; yours: number }) {
  return (
    <ol aria-label="Prompt sources" className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-3">
      <li className="flex flex-col gap-1.5 rounded-md border border-edge bg-surface p-3">
        <span className={`${labelType} text-muted`}>Bundled · {bundled}</span>
        <span className="font-bold">Ship with Harmonic</span>
        <span className="text-small text-muted">Read-only. Duplicate to change.</span>
      </li>
      <li className="flex flex-col gap-1.5 rounded-md border-2 border-accent bg-surface p-[11px]">
        <span className={`${labelType} text-accent`}>Yours · {yours}</span>
        <span className="font-bold">Editable</span>
        <span className="text-small text-muted">Edits apply to the next execution.</span>
      </li>
      <li className="flex flex-col gap-1.5 rounded-md border border-dashed border-edge-strong bg-sunken p-3">
        <span className={`${labelType} text-muted`}>Fixed</span>
        <span className="font-bold">Critic safety guard</span>
        <span className="text-small text-muted">Appended by the engine. Not editable.</span>
      </li>
    </ol>
  );
}

export function PromptFind() {
  const flow = usePromptsFlow();
  const [query, setQuery] = useState('');
  const [view, setView] = useState<PromptFilter>('all');
  const all = flow.prompts;
  const counts = useMemo(() => filterCounts(all), [all]);
  const { bundled, yours } = libraryCounts(all);
  const shown = useMemo(() => filterPrompts(filterByView(all, view), query), [all, view, query]);
  const noneOfYours = yours === 0;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h2 className="text-display font-semibold">Which prompt do you want to change?</h2>
          <p className="text-body text-muted">
            Workflow steps name a prompt by code. A prompt can include another with <span className={INC_CHIP}>{'${{ prompts.code }}'}</span>, so shared text lives in one place.
          </p>
        </div>
        <button type="button" className={btnPrimary} onClick={flow.startNew}>
          + New prompt
        </button>
      </div>

      {flow.error && <LoadError message={flow.error} onRetry={flow.reload} />}
      {!flow.loaded && !flow.error && <p className="text-muted">Loading prompts…</p>}

      {flow.loaded && (
        <>
          <SourceStrip bundled={bundled} yours={yours} />

          <article className="flex flex-col gap-3 rounded-lg bg-surface p-5 shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="relative w-80 max-w-full">
                <span className="sr-only">Search prompts</span>
                <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by code or description"
                  className={`${searchField} w-full pl-8`}
                />
              </label>
              <div role="tablist" aria-label="Filter" className="flex gap-0.5 rounded-md bg-hairline p-[3px]">
                {PROMPT_FILTERS.map((f) => (
                  <button
                    key={f.id}
                    role="tab"
                    type="button"
                    aria-selected={view === f.id}
                    onClick={() => setView(f.id)}
                    className={`min-h-9 rounded-sm px-3 text-body font-semibold ${view === f.id ? 'bg-surface text-ink shadow-card' : 'text-ink'}`}
                  >
                    {f.label} {counts[f.id]}
                  </button>
                ))}
              </div>
            </div>

            {shown.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-data">
                  <thead>
                    <tr className={`${labelType} text-muted`}>
                      <th className="border-b border-hairline px-2 py-2">Code</th>
                      <th className="border-b border-hairline px-2 py-2">What it’s for</th>
                      <th className="border-b border-hairline px-2 py-2">Source</th>
                      <th className="border-b border-hairline px-2 py-2 text-right">Used by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((p) => (
                      <tr key={p.code} className={flow.selected === p.code ? 'bg-accent-tint' : undefined} data-prompt={p.code}>
                        <td className="border-b border-hairline px-2 py-3 align-top">
                          <button
                            type="button"
                            onClick={() => flow.pick(p.code)}
                            aria-current={flow.selected === p.code ? 'true' : undefined}
                            className={`relative font-data text-ink underline-offset-2 after:absolute after:-inset-3 after:content-[''] hover:underline ${flow.selected === p.code ? 'font-bold' : 'font-semibold'}`}
                          >
                            {p.code}
                          </button>
                        </td>
                        <td className="border-b border-hairline px-2 py-3 align-top text-muted">{p.description}</td>
                        <td className="border-b border-hairline px-2 py-3 align-top">
                          <SourceBadge bundled={p.bundled} />
                        </td>
                        <td className={`whitespace-nowrap border-b border-hairline px-2 py-3 text-right align-top ${p.usedBy.length + p.usedBySteps.length === 0 ? 'text-muted' : ''}`}>
                          {usedByLabel(p)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {shown.length === 0 && query.trim() !== '' && (
              <EmptyPanel
                title={`No prompts match “${query.trim()}”`}
                action={
                  <button type="button" className={btnGhost} onClick={() => setQuery('')}>
                    Clear search
                  </button>
                }
              >
                Search looks at codes and descriptions. Bundled prompts ship with Harmonic; Duplicate one to edit.
              </EmptyPanel>
            )}
            {shown.length === 0 && query.trim() === '' && view !== 'all' && (
              <EmptyPanel
                title={view === 'yours' ? 'You have no prompts of your own yet' : 'Every prompt is in use'}
                action={
                  <button type="button" className={btnGhost} onClick={() => setView('all')}>
                    Show all
                  </button>
                }
              >
                {view === 'yours' ? 'Bundled prompts ship with Harmonic. Duplicate one to edit.' : 'Unused prompts are not named by any workflow step or included by another prompt.'}
              </EmptyPanel>
            )}
            {shown.length > 0 && noneOfYours && view === 'all' && (
              <EmptyPanel
                title="You have no prompts of your own yet"
                action={
                  <button type="button" className={btnGhost} onClick={flow.startNew}>
                    + New prompt
                  </button>
                }
              >
                Bundled prompts ship with Harmonic. Duplicate one to edit.
              </EmptyPanel>
            )}
          </article>
        </>
      )}

      <p className="text-small text-muted">
        There is no per-Workspace or per-Ticket prompt text. Need different wording? Choose a different prompt or workflow in{' '}
        <a href="/settings?tab=execution" className="font-semibold text-accent hover:text-accent-hot">
          Running Tickets
        </a>
        , or pass values through <span className="font-data">vars</span>.
      </p>
    </div>
  );
}

function EmptyPanel({ title, children, action }: { title: string; children: string; action: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-edge bg-sunken">
      <EmptyState title={title} action={action} className="py-9">
        {children}
      </EmptyState>
    </div>
  );
}
