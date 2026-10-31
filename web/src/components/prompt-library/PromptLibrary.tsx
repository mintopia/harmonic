import { useMemo, useState } from 'react';
import { api } from '../../api';
import { filterPrompts } from '../../prompt-library-model';
import { useAsyncResource } from '../../useAsyncResource';
import { LoadError } from '../LoadError';
import { PromptEditor } from './PromptEditor';
import { PromptList } from './PromptList';

const NEW = Symbol('new');

export function PromptLibrary() {
  const { data, error, reload } = useAsyncResource(() => api.prompts(), []);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | typeof NEW | null>(null);

  const all = useMemo(() => data?.prompts ?? [], [data]);
  const shown = useMemo(() => filterPrompts(all, query), [all, query]);
  const current = typeof selected === 'string' ? (all.find((p) => p.code === selected) ?? null) : null;

  return (
    <section aria-label="Prompt Library" className="rounded-lg bg-surface p-5 shadow-card">
      {error && <LoadError message={error} onRetry={reload} className="mb-3" />}
      {data && (
        <>
          <PromptList
            all={all}
            shown={shown}
            query={query}
            selected={typeof selected === 'string' ? selected : null}
            onQuery={setQuery}
            onSelect={setSelected}
            onNew={() => setSelected(NEW)}
          />
          {selected === NEW && (
            <PromptEditor
              key="new"
              prompt={null}
              prompts={all}
              onSaved={(saved) => {
                reload();
                setSelected(saved.code);
              }}
              onDeleted={() => {}}
              onDuplicated={() => {}}
              onOpen={setSelected}
              onClose={() => setSelected(null)}
            />
          )}
          {current && (
            <PromptEditor
              key={current.code}
              prompt={current}
              prompts={all}
              onSaved={reload}
              onDeleted={() => {
                reload();
                setSelected(null);
              }}
              onDuplicated={(copy) => {
                reload();
                setSelected(copy.code);
              }}
              onOpen={setSelected}
              onClose={() => setSelected(null)}
            />
          )}
        </>
      )}
      {!data && !error && <p className="text-muted">Loading prompts…</p>}
    </section>
  );
}
