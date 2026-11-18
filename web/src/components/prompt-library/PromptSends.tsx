import { useEffect, useState, type ReactNode } from 'react';
import type { PromptSegment, PromptStepKind } from '../../../../src/execution/prompt-assembly.js';
import { resolvePrompt } from '../../../../src/domain/prompt-library.js';
import { api } from '../../api';
import { errorText } from '../../error-text';
import { sendContexts } from '../../prompt-library-model';
import { fillSample } from '../../prompt-preview-model';
import type { Prompt } from '../../types';
import { field, labelType } from '../../ui';
import { UsedBy } from './UsedBy';

const BODY = 'text-body leading-[1.65]';
const BLOCK = 'block rounded-r-sm border-l-[3px] px-2.5 py-1.5';
const BLOCK_LABEL = 'mb-1 flex items-center gap-1.5 font-sans text-label font-semibold uppercase';

type Mode = 'structure' | 'sent';

function useEngineSegments(uses: PromptStepKind): { segments: PromptSegment[] | null; error: string | null } {
  const [state, setState] = useState<{ uses: PromptStepKind; segments: PromptSegment[] | null; error: string | null } | null>(null);
  useEffect(() => {
    if (uses === 'agent') return;
    let live = true;
    api.assemblePrompt(uses, '').then(
      (r) => live && setState({ uses, segments: r.segments.filter((s) => s.source === 'engine'), error: null }),
      (err: unknown) => live && setState({ uses, segments: null, error: errorText(err) }),
    );
    return () => {
      live = false;
    };
  }, [uses]);
  if (uses === 'agent') return { segments: [], error: null };
  return state?.uses === uses ? state : { segments: null, error: null };
}

export function PromptSends({
  prompt,
  text,
  prompts,
  fields,
  editor,
}: {
  prompt: Prompt | null;
  text: string;
  prompts: readonly Prompt[];
  fields: ReactNode;
  editor: ReactNode;
}) {
  const contexts = sendContexts(prompt?.usedBySteps ?? []);
  const [picked, setPicked] = useState(0);
  const [mode, setMode] = useState<Mode>('structure');
  const context = contexts[Math.min(picked, contexts.length - 1)]!;
  const { segments, error } = useEngineSegments(context.uses);

  const lookup = new Map(prompts.map((p) => [p.code, p.text]));
  if (prompt) lookup.set(prompt.code, text);
  const seen = prompt ? [prompt.code] : [];
  const modeButton = (id: Mode, label: string) => (
    <button
      type="button"
      aria-pressed={mode === id}
      onClick={() => setMode(id)}
      className={`rounded-sm px-2.5 py-1 text-small font-semibold ${mode === id ? 'bg-surface text-ink shadow-card' : 'text-muted'}`}
    >
      {label}
    </button>
  );

  return (
    <article aria-label="What the step sends" className="flex flex-col gap-3.5 rounded-lg bg-surface p-[18px] shadow-card">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex flex-wrap items-center gap-2 text-small text-muted">
          <span className={labelType}>Sent by</span>
          <select value={contexts.indexOf(context)} onChange={(e) => setPicked(Number(e.target.value))} className={`${field} !min-h-0 !w-auto !py-1`}>
            {contexts.map((c, i) => (
              <option key={i} value={i}>
                {c.label} · {c.uses}
              </option>
            ))}
          </select>
        </label>
        <div role="group" aria-label="Preview mode" className="flex gap-0.5 rounded-md bg-raised p-0.5">
          {modeButton('structure', 'Structure')}
          {modeButton('sent', 'As sent')}
        </div>
      </header>
      {fields}
      <UsedBy prompt={prompt} />
      <div data-testid="step-sends" className="flex flex-col gap-2">
        <div data-segment="operator" className="flex flex-col gap-3.5">
          {mode === 'structure' ? (
            editor
          ) : (
            <div className={`whitespace-pre-wrap rounded-sm border border-hairline bg-sunken p-3 ${BODY}`}>{fillSample(resolvePrompt(text, lookup, seen))}</div>
          )}
        </div>
        {segments === null && (
          <p className="text-small text-muted">{error ? `Couldn’t load the engine’s parts: ${error}` : 'Loading the engine’s parts…'}</p>
        )}
        {segments?.map((s) => (
          <div key={s.label} data-segment="engine" className={`${BLOCK} border-edge bg-raised ${BODY}`}>
            <span className={`${BLOCK_LABEL} text-muted`}>
              {s.label} <span className="font-normal normal-case tracking-normal">· added by the engine, can’t be edited</span>
            </span>
            <div className="whitespace-pre-wrap text-muted">{s.text}</div>
          </div>
        ))}
      </div>
    </article>
  );
}
