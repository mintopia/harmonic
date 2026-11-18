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

const MONO = 'font-data text-[13px] leading-[1.65]';
const ENGINE_PARTS: Record<string, string> = { 'Read-only critic guard': 'criticRole + criticSecurity', 'Verdict contract': 'verdict contract' };

const TONES = {
  operator: { frame: 'border-2 border-accent', head: 'bg-accent-tint text-accent' },
  engine: { frame: 'border border-hairline', head: 'bg-await-tint text-await' },
} as const;

function Block({ tone, label, sub, aside, segment, children }: { tone: keyof typeof TONES; label: string; sub?: ReactNode; aside?: string; segment: string; children: ReactNode }) {
  return (
    <div data-segment={segment} className={`overflow-hidden rounded-md ${TONES[tone].frame}`}>
      <div className={`flex flex-wrap items-baseline gap-x-2 px-3 py-2 ${TONES[tone].head}`}>
        <span className="font-sans text-label font-semibold uppercase">{label}</span>
        {sub && <span className="min-w-0 break-words font-data text-small text-ink">{sub}</span>}
        {aside && <span className="ml-auto font-data text-small text-muted">{aside}</span>}
      </div>
      {children}
    </div>
  );
}

const SWATCH = 'mr-1.5 inline-block size-2.5 rounded-sm align-[-1px]';

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
  title,
  fields,
  aside,
  editor,
  footer,
  notice,
}: {
  prompt: Prompt | null;
  text: string;
  prompts: readonly Prompt[];
  title: ReactNode;
  fields: ReactNode;
  aside: string;
  editor: ReactNode;
  footer: ReactNode;
  notice: ReactNode;
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
      className={`rounded-sm px-3 py-1.5 text-small font-semibold ${mode === id ? 'bg-accent text-on-accent' : 'text-muted'}`}
    >
      {label}
    </button>
  );

  return (
    <article aria-label="Prompt editor" className="flex min-w-0 flex-col overflow-hidden rounded-lg bg-surface shadow-card">
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 border-b border-hairline px-4 py-4">
        {title}
        <div role="group" aria-label="Preview mode" className="col-start-2 row-start-1 flex shrink-0 gap-0.5 rounded-md border border-edge p-0.5">
          {modeButton('structure', 'Structure')}
          {modeButton('sent', 'As sent')}
        </div>
      </header>
      <div className="flex flex-col gap-3.5 p-4">
        {fields}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={`${labelType} text-muted`}>What the step actually sends</span>
          <label className="flex items-center gap-2 text-small text-muted">
            <span>Sent by</span>
            <select value={contexts.indexOf(context)} onChange={(e) => setPicked(Number(e.target.value))} className={`${field} !min-h-0 !w-auto !py-1`}>
              {contexts.map((c, i) => (
                <option key={i} value={i}>
                  {c.label} · {c.uses}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div data-testid="step-sends" className="flex flex-col gap-3">
          <Block tone="operator" label="Your prompt" sub={prompt?.code} aside={mode === 'structure' ? aside : undefined} segment="operator">
            {mode === 'structure' ? (
              <>
                <div className="flex flex-col gap-3.5 bg-field">{editor}</div>
                {footer}
              </>
            ) : (
              <div className={`whitespace-pre-wrap break-words bg-field px-4 py-3 ${MONO}`}>{fillSample(resolvePrompt(text, lookup, seen))}</div>
            )}
          </Block>
          {segments === null && <p className="text-small text-muted">{error ? `Couldn’t load the engine’s parts: ${error}` : 'Loading the engine’s parts…'}</p>}
          {segments?.map((s) => (
            <Block key={s.label} tone="engine" label="Engine · appended" sub={ENGINE_PARTS[s.label] ?? s.label} aside="not editable" segment="engine">
              <div className={`whitespace-pre-wrap break-words bg-sunken px-4 py-3 text-ink ${MONO}`}>{s.text}</div>
            </Block>
          ))}
        </div>
        {notice}
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-small text-muted">
          <span><i className={`${SWATCH} bg-accent-tint`} />your prompt (editable)</span>
          {(segments?.length ?? 0) > 0 && <span><i className={`${SWATCH} bg-await-tint`} />engine-appended (fixed)</span>}
          <span><i className={`${SWATCH} bg-ready-tint`} />filled at run time</span>
        </p>
        <UsedBy prompt={prompt} />
      </div>
    </article>
  );
}
