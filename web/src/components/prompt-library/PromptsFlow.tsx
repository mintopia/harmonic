import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../../api';
import { unsavedChanges, usedByLabel } from '../../prompt-library-model';
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
  error: string | null;
  reload: () => void;
  selected: string | null;
  isNew: boolean;
  current: Prompt | null;
  draft: PromptDraft;
  changes: number;
  setDraft: (patch: Partial<PromptDraft>) => void;
  discard: () => void;
  pick: (code: string) => void;
  startNew: () => void;
  goFind: () => void;
  goStep: (step: string) => void;
  afterSave: (saved: Prompt) => void;
  afterDelete: () => void;
  afterDuplicate: (copy: Prompt) => void;
}

const FlowContext = createContext<PromptsFlow | null>(null);

export function usePromptsFlow(): PromptsFlow {
  const flow = useContext(FlowContext);
  if (!flow) throw new Error('usePromptsFlow needs a PromptsFlowProvider');
  return flow;
}

export function useOptionalPromptsFlow(): PromptsFlow | null {
  return useContext(FlowContext);
}

export interface PromptsRailState {
  disabled: ReadonlySet<string>;
  values: Readonly<Record<string, string | undefined>>;
  summaries: Readonly<Record<string, string | undefined>>;
}

export function promptsRailState(flow: PromptsFlow | null): PromptsRailState {
  const none = !flow || flow.selected === null;
  const current = flow?.current ?? null;
  const edit = current?.bundled ? 'Read-only' : flow && flow.changes > 0 ? `${flow.changes} unsaved ${flow.changes === 1 ? 'change' : 'changes'}` : 'Change the text';
  return {
    disabled: new Set(none ? ['edit', 'impact'] : []),
    values: { find: flow?.selected ?? undefined },
    summaries: {
      find: 'Pick a prompt',
      edit: none ? 'Pick a prompt first' : edit,
      impact: none ? 'Pick a prompt first' : current ? usedByLabel(current) : 'A new prompt is unused',
    },
  };
}

export function PromptsFlowProvider({
  active,
  onStep,
  children,
}: {
  active: boolean;
  onStep: (step: string) => void;
  children?: ReactNode;
}) {
  const { data, error, reload } = useAsyncResource(active ? () => api.prompts() : null, [active]);
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

  const forget = useCallback((key: string) => setDrafts(({ [key]: _gone, ...rest }) => rest), []);

  const open = useCallback(
    (key: string) => {
      setSelected(key);
      onStep('edit');
    },
    [onStep],
  );

  const flow: PromptsFlow = {
    prompts,
    loaded: data !== null,
    error,
    reload,
    selected,
    isNew,
    current,
    draft,
    changes,
    setDraft,
    discard: () => selected !== null && forget(selected),
    pick: open,
    startNew: () => open(NEW_PROMPT),
    goFind: () => onStep('find'),
    goStep: onStep,
    afterSave: (saved) => {
      forget(saved.code);
      forget(NEW_PROMPT);
      setPatched((all) => [...all.filter((p) => p.code !== saved.code), saved]);
      reload();
      setSelected(saved.code);
    },
    afterDelete: () => {
      if (selected !== null) forget(selected);
      reload();
      setSelected(null);
      onStep('find');
    },
    afterDuplicate: (copy) => {
      reload();
      open(copy.code);
    },
  };

  return <FlowContext.Provider value={flow}>{children}</FlowContext.Provider>;
}
