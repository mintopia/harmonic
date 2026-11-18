import { useEffect, useState } from 'react';
import type { PromptSegment, PromptStepKind } from '../../../../src/execution/prompt-assembly.js';
import { resolvePrompt } from '../../../../src/domain/prompt-library.js';
import { api } from '../../api';
import { errorText } from '../../error-text';
import { previewTree, sendContexts, type PreviewNode } from '../../prompt-library-model';
import { fillSample } from '../../prompt-preview-model';
import type { Prompt } from '../../types';
import { field, labelType } from '../../ui';

const PH = 'rounded-sm bg-ready-tint px-1 font-data text-[12px] text-ready';
const BODY = 'text-body leading-[1.65]';
const BLOCK = 'block rounded-r-sm border-l-[3px] px-2.5 py-1.5';
const BLOCK_LABEL = 'mb-1 flex items-center gap-1.5 font-sans text-label font-semibold uppercase';

type Mode = 'structure' | 'sent';

function Preview({ nodes }: { nodes: readonly PreviewNode[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        if (n.kind === 'text') {
          let value = n.value;
          if (nodes[i - 1]?.kind === 'include') value = value.replace(/^\n/, '');
          if (nodes[i + 1]?.kind === 'include') value = value.replace(/\n$/, '');
          return <span key={i} className="whitespace-pre-wrap">{value}</span>;
        }
        if (n.kind === 'context') return <span key={i} data-ref="context" className={PH}>{n.value}</span>;
        if (n.kind === 'field') return <span key={i} data-ref="field" className={PH}>{`{${n.value}}`}</span>;
        const nested = n.depth > 1;
        return (
          <span key={i} data-include={n.code} className={`my-1.5 ${BLOCK} ${nested ? 'border-await bg-await-tint' : 'border-accent bg-accent-tint'}`}>
            <span className={`${BLOCK_LABEL} ${nested ? 'text-await' : 'text-accent'}`}>
              Included from <code className="font-data text-[11px] normal-case tracking-normal">{n.code}</code>
            </span>
            <Preview nodes={n.children} />
          </span>
        );
      })}
    </>
  );
}

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

export function PromptSends({ prompt, text, prompts }: { prompt: Prompt | null; text: string; prompts: readonly Prompt[] }) {
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
    <article aria-label="What the step sends" className="flex flex-col gap-2.5 rounded-lg bg-sunken p-[18px] shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-title font-semibold text-ink">What a step sends</h3>
        <div role="group" aria-label="Preview mode" className="flex gap-0.5 rounded-md bg-raised p-0.5">
          {modeButton('structure', 'Structure')}
          {modeButton('sent', 'As sent')}
        </div>
      </div>
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
      <p className="text-small text-muted">
        {mode === 'structure' ? 'Your prompt with every include expanded, then anything the engine appends. Updates as you type.' : 'The full text the step sends, filled with sample values.'}
      </p>
      <div data-testid="step-sends" className={`flex flex-col gap-2 rounded-sm border border-hairline bg-surface p-3 ${BODY}`}>
        <div data-segment="operator">
          <span className={`${BLOCK_LABEL} text-muted`}>Your prompt</span>
          {mode === 'structure' ? (
            <div data-testid="include-preview">
              <Preview nodes={previewTree(text, lookup, seen)} />
            </div>
          ) : (
            <div className="whitespace-pre-wrap">{fillSample(resolvePrompt(text, lookup, seen))}</div>
          )}
        </div>
        {segments === null && (
          <p className="text-small text-muted">{error ? `Couldn’t load the engine’s parts: ${error}` : 'Loading the engine’s parts…'}</p>
        )}
        {segments?.map((s) => (
          <div key={s.label} data-segment="engine" className={`${BLOCK} border-edge bg-raised`}>
            <span className={`${BLOCK_LABEL} text-muted`}>
              {s.label} <span className="font-normal normal-case tracking-normal">· added by the engine, can’t be edited</span>
            </span>
            <div className="whitespace-pre-wrap text-muted">{s.text}</div>
          </div>
        ))}
      </div>
      {mode === 'structure' && (
        <div className="flex flex-wrap gap-3.5 text-micro text-muted">
          <span><i className="mr-1.5 inline-block size-2.5 rounded-sm bg-accent-tint shadow-[inset_3px_0_0_var(--color-accent)]" />included prompt</span>
          <span><i className="mr-1.5 inline-block size-2.5 rounded-sm bg-await-tint shadow-[inset_3px_0_0_var(--color-await)]" />nested include</span>
          <span><i className="mr-1.5 inline-block size-2.5 rounded-sm bg-ready-tint" /><span className="text-ready">blue</span> filled at run time</span>
          <span><i className="mr-1.5 inline-block size-2.5 rounded-sm bg-raised shadow-[inset_3px_0_0_var(--color-edge)]" />added by the engine</span>
        </div>
      )}
    </article>
  );
}
