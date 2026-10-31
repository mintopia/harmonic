import { btnGhost, btnPrimary, labelType, searchField } from '../../ui';
import { countsLabel, usedByLabel } from '../../prompt-library-model';
import type { Prompt } from '../../types';
import { EmptyState } from '../EmptyState';
import { Icon } from '../Icon';
import { SourceBadge } from './SourceBadge';

export function PromptList({
  all,
  shown,
  query,
  selected,
  onQuery,
  onSelect,
  onNew,
}: {
  all: readonly Prompt[];
  shown: readonly Prompt[];
  query: string;
  selected: string | null;
  onQuery: (query: string) => void;
  onSelect: (code: string) => void;
  onNew: () => void;
}) {
  const noneOfYours = all.every((p) => p.bundled);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[18px] font-bold tracking-[-0.015em] text-ink">Prompt Library</h3>
          <p className="mt-0.5 text-[13px] text-muted">
            Named prompts that Task Execution Workflow steps use by code. A prompt can include another with <code className="font-data">{'${{ prompts.code }}'}</code>.
          </p>
        </div>
        <button type="button" className={btnPrimary} onClick={onNew}>
          + New prompt
        </button>
      </div>

      <div className="mb-2.5 flex flex-wrap items-center gap-2.5">
        <label className="relative min-w-[200px] max-w-sm flex-1">
          <span className="sr-only">Search prompts</span>
          <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search by code or description"
            className={`${searchField} w-full pl-8`}
          />
        </label>
        <span className="flex-1" />
        <span className="text-small text-muted">{countsLabel(all)}</span>
      </div>

      {shown.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className={`${labelType} text-muted`}>
                <th className="border-b border-hairline px-3 py-2">Code</th>
                <th className="border-b border-hairline px-3 py-2">Description</th>
                <th className="border-b border-hairline px-3 py-2">Source</th>
                <th className="border-b border-hairline px-3 py-2 text-right">Used by</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.code} className={selected === p.code ? 'bg-accent-tint' : undefined} data-prompt={p.code}>
                  <td className="border-b border-hairline px-3 py-3 align-top">
                    <button
                      type="button"
                      onClick={() => onSelect(p.code)}
                      aria-current={selected === p.code ? 'true' : undefined}
                      className="relative font-data font-medium text-ink underline-offset-2 after:absolute after:-inset-3 after:content-[''] hover:underline"
                    >
                      {p.code}
                    </button>
                  </td>
                  <td className="border-b border-hairline px-3 py-3 align-top text-muted">{p.description}</td>
                  <td className="border-b border-hairline px-3 py-3 align-top">
                    <SourceBadge bundled={p.bundled} />
                  </td>
                  <td className={`whitespace-nowrap border-b border-hairline px-3 py-3 text-right align-top ${p.usedBy.length === 0 ? 'text-muted' : ''}`}>
                    {usedByLabel(p)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {shown.length === 0 && query.trim() !== '' && (
        <EmptyPanel title={`No prompts match “${query.trim()}”`} action={<ClearButton onClick={() => onQuery('')} />}>
          Search looks at codes and descriptions. Bundled prompts ship with Harmonic; Duplicate one to edit.
        </EmptyPanel>
      )}
      {shown.length > 0 && noneOfYours && (
        <div className="mt-3">
          <EmptyPanel
            title="You have no prompts of your own yet"
            action={
              <button type="button" className={btnGhost} onClick={onNew}>
                + New prompt
              </button>
            }
          >
            Bundled prompts ship with Harmonic. Duplicate one to edit.
          </EmptyPanel>
        </div>
      )}
    </div>
  );
}

function ClearButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className={btnGhost} onClick={onClick}>
      Clear search
    </button>
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
