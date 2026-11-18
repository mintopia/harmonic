import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../../api';
import { renameIncludes } from '../../../../src/domain/prompt-library.js';
import { unsavedChanges } from '../../prompt-library-model';
import type { Prompt } from '../../types';
import { useAsyncResource } from '../../useAsyncResource';

export const NEW_PROMPT = '';

export interface PromptDraft {
  code: string;
  description: string;
  text: string;
}

export interface PromptsFlow {
  prompts: readonly Prompt[];
  loaded: boolean;
  includeFragments: boolean;
  setIncludeFragments: (include: boolean) => void;
  error: string | null;
  reload: () => void;
  selected: string | null;
  isNew: boolean;
  current: Prompt | null;
  draft: PromptDraft;
  changes: number;
  setDraft: (patch: Partial<PromptDraft>) => void;
  draftOf: (prompt: Prompt) => PromptDraft;
  setDraftOf: (prompt: Prompt, patch: Partial<PromptDraft>) => void;
  discardOf: (code: string) => void;
  discard: () => void;
  pick: (code: string) => void;
  startNew: () => void;
  afterSave: (saved: Prompt) => void;
  afterDelete: () => void;
  afterRename: (from: string, renamed: Prompt) => void;
  /** A different `saved.code` means a bundled include was forked; `parent` is the stored parent once repointed. */
  afterIncludeSave: (from: string, saved: Prompt, parent: Prompt | null) => void;
}

const baseOf = (p: Prompt): PromptDraft => ({ code: p.code, description: p.description, text: p.text });

const FlowContext = createContext<PromptsFlow | null>(null);

export function usePromptsFlow(): PromptsFlow {
  const flow = useContext(FlowContext);
  if (!flow) throw new Error('usePromptsFlow needs a PromptsFlowProvider');
  return flow;
}

export function useOptionalPromptsFlow(): PromptsFlow | null {
  return useContext(FlowContext);
}

export function PromptsFlowProvider({ active, children }: { active: boolean; children?: ReactNode }) {
  const { data, error, reload } = useAsyncResource(active ? () => api.prompts() : null, [active]);
  const [includeFragments, setIncludeFragments] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, PromptDraft>>>({});

  const [patched, setPatched] = useState<readonly Prompt[]>([]);
  useEffect(() => setPatched([]), [data]);
  const prompts = useMemo(() => {
    const list = data?.prompts ?? [];
    const merged = list.map((p) => patched.find((x) => x.code === p.code) ?? p);
    return [...merged, ...patched.filter((x) => !list.some((p) => p.code === x.code))];
  }, [data, patched]);
  const isNew = selected === NEW_PROMPT;
  const current = selected && !isNew ? (prompts.find((p) => p.code === selected) ?? null) : null;
  const base: PromptDraft = { code: current?.code ?? '', description: current?.description ?? '', text: current?.text ?? '' };
  const draft = selected === null ? base : (drafts[selected] ?? base);
  const changes = isNew
    ? Number(draft.code !== '' || draft.description !== '' || draft.text !== '')
    : current
      ? unsavedChanges(current, draft)
      : 0;

  const setDraft = (patch: Partial<PromptDraft>) => {
    if (selected === null) return;
    setDrafts((all) => ({ ...all, [selected]: { ...(all[selected] ?? base), ...patch } }));
  };

  const setDraftOf = (p: Prompt, patch: Partial<PromptDraft>) => setDrafts((all) => ({ ...all, [p.code]: { ...(all[p.code] ?? baseOf(p)), ...patch } }));

  const forget = useCallback((key: string) => setDrafts(({ [key]: _gone, ...rest }) => rest), []);

  const flow: PromptsFlow = {
    prompts,
    loaded: data !== null,
    includeFragments,
    setIncludeFragments,
    error,
    reload,
    selected,
    isNew,
    current,
    draft,
    changes,
    setDraft,
    draftOf: (p) => drafts[p.code] ?? baseOf(p),
    setDraftOf,
    discardOf: (code) => forget(code),
    discard: () => selected !== null && forget(selected),
    pick: setSelected,
    startNew: () => setSelected(NEW_PROMPT),
    afterSave: (saved) => {
      if (selected !== null) forget(selected);
      forget(saved.code);
      setPatched((all) => [...all.filter((p) => p.code !== saved.code), saved]);
      reload();
      setSelected(saved.code);
    },
    afterDelete: () => {
      if (selected !== null) forget(selected);
      reload();
      setSelected(null);
    },
    afterRename: (from, renamed) => {
      forget(from);
      setPatched((all) => [...all.filter((p) => p.code !== from && p.code !== renamed.code), renamed]);
      reload();
      setSelected(renamed.code);
    },
    afterIncludeSave: (from, saved, parent) => {
      forget(from);
      setPatched((all) => [...all.filter((p) => p.code !== saved.code && p.code !== parent?.code), saved, ...(parent ? [parent] : [])]);
      if (saved.code !== from && current) {
        setDrafts((all) => {
          const was = all[current.code] ?? baseOf(current);
          return { ...all, [current.code]: { ...was, text: renameIncludes(was.text, from, saved.code) } };
        });
      }
      reload();
    },
  };

  return <FlowContext.Provider value={flow}>{children}</FlowContext.Provider>;
}
