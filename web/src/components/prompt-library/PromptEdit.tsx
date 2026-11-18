import { Fragment, useRef, useState } from 'react';
import { ApiError, api } from '../../api';
import { includedCodes, renameIncludes } from '../../../../src/domain/prompt-library.js';
import { toastError } from '../../toast';
import type { Prompt } from '../../types';
import {
  applySuggestion,
  badSpans,
  copyCode,
  highlightLine,
  localIssues,
  unsavedChanges,
  validateCode,
  type BadSpan,
  type SaveIssue,
  type TextSegment,
} from '../../prompt-library-model';
import { btnGhost, btnPrimary, field, labelType } from '../../ui';
import { Icon } from '../Icon';
import { PromptHeader, SaveAsNewDialog } from './PromptHeader';
import { usePromptsFlow } from './PromptsFlow';
import { PromptSends } from './PromptSends';
import { SourceBadge } from './SourceBadge';

const CHIP_RESET = 'group-focus-within:px-0 group-focus-within:[font:inherit]';
const INC = `rounded-sm bg-tool-tint px-1 font-data text-[12.5px] text-tool ${CHIP_RESET}`;
const CTX = `rounded-sm bg-ready-tint px-1 font-data text-[12.5px] text-ready ${CHIP_RESET}`;
const BAD = `rounded-sm bg-fail-tint px-1 font-data text-[12.5px] text-fail underline decoration-fail decoration-wavy underline-offset-[3px] ${CHIP_RESET}`;
const BODY = 'text-body leading-[1.65]';

function Segments({ segments }: { segments: readonly TextSegment[] }) {
  const classes = { include: INC, context: CTX, bad: BAD } as const;
  return (
    <>
      {segments.map((s, i) => (s.kind === 'text' ? <span key={i}>{s.value}</span> : <span key={i} data-ref={s.kind} className={classes[s.kind]}>{s.value}</span>))}
    </>
  );
}

function TextBox({
  id,
  text,
  bad,
  invalid,
  areaRef,
  onChange,
  compact = false,
}: {
  id: string;
  text: string;
  bad: readonly BadSpan[];
  invalid: boolean;
  areaRef?: React.RefObject<HTMLTextAreaElement | null>;
  onChange: (text: string) => void;
  compact?: boolean;
}) {
  const lines = text.split('\n');
  const last = lines.length - 1;
  return (
    <div
      className={`group relative grid grid-cols-[36px_1fr] content-start overflow-hidden rounded-md border ${
        invalid ? 'border-fail' : 'border-edge focus-within:border-accent'
      } ${compact ? 'min-h-[80px]' : 'min-h-[230px]'} bg-field`}
    >
      <div aria-hidden="true" className="absolute inset-y-0 left-0 w-9 border-r border-hairline bg-sunken" />
      {lines.map((l, i) => (
        <Fragment key={i}>
          <div
            aria-hidden="true"
            data-gutter={i + 1}
            className={`relative select-none pr-1.5 text-right font-data text-small leading-[23.1px] ${i === 0 ? 'pt-2.5' : ''} ${i === last ? 'pb-2.5' : ''} ${
              bad.some((b) => b.line === i + 1) ? 'font-semibold text-fail' : 'text-faint'
            }`}
          >
            {i + 1}
          </div>
          <div className={`min-h-[23.1px] whitespace-pre-wrap break-words px-3 ${BODY} ${i === 0 ? 'pt-2.5 min-h-[33.1px]' : ''} ${i === last ? 'pb-2.5 min-h-[33.1px]' : ''}`}>
            <Segments segments={highlightLine(l, bad.filter((b) => b.line === i + 1))} />
          </div>
        </Fragment>
      ))}
      <textarea
        id={id}
        ref={areaRef}
        value={text}
        maxLength={100_000}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid ? true : undefined}
        spellCheck={false}
        className={`absolute inset-y-0 left-9 right-0 resize-none overflow-hidden whitespace-pre-wrap break-words border-0 bg-transparent px-3 py-2.5 text-transparent caret-ink focus:outline-none ${BODY}`}
      />
    </div>
  );
}

function issueMessage(issue: SaveIssue) {
  const at = (p: { line: number; column: number } | null) => (p ? ` at line ${p.line}, column ${p.column}` : '');
  const code = 'rounded bg-surface px-1.5 font-data text-ink';
  switch (issue.kind) {
    case 'cycle':
      return (
        <>
          <b>Include cycle: </b>
          {issue.path.map((c, i) => (
            <span key={i}>
              {i > 0 && ' → '}
              <code className={code}>{c}</code>
            </span>
          ))}
          .{issue.position ? ` Line ${issue.position.line}.` : ''} Remove one of the includes.
        </>
      );
    case 'unknown':
      return (
        <>
          <b>Unknown prompt code </b>
          <code className={code}>{issue.code}</code>
          {at(issue.position)}.
          {issue.suggestion && (
            <>
              {' '}
              Did you mean <code className={code}>{issue.suggestion}</code>?
            </>
          )}
        </>
      );
    case 'malformed':
      return (
        <>
          <b>Malformed reference</b>
          {at(issue.position)}: <code className={code}>{'${{'}</code> is never closed. Add <code className={code}>{'}}'}</code>.
        </>
      );
    case 'code': {
      const m = /^(A prompt with the code )(\S+)( already exists.*)$/.exec(issue.message);
      return m ? (
        <>
          {m[1]}
          <code className="font-data text-[13px]">{m[2]}</code>
          {m[3]}
        </>
      ) : (
        issue.message
      );
    }
    default:
      return issue.message;
  }
}

function ErrorBox({ issue, onFix }: { issue: SaveIssue; onFix?: () => void }) {
  return (
    <div role="alert" data-issue={issue.kind} className="mt-1.5 flex items-start gap-2 rounded-sm bg-fail-tint px-2.5 py-2 text-small text-fail">
      <Icon name="alert-triangle" className="mt-px size-3.5 shrink-0" />
      <span className="text-ink">
        {issueMessage(issue)}
        {onFix && (
          <button type="button" onClick={onFix} className="ml-1.5 font-semibold text-accent underline underline-offset-2">
            Use suggestion
          </button>
        )}
      </span>
    </div>
  );
}

const SMALL = '!min-h-0 !px-2.5 !py-1 !text-small';
const SMALL_BTN = `${btnGhost} ${SMALL}`;
const DISCLOSURE = 'flex min-h-11 cursor-pointer list-none items-center gap-2 py-2 [&::-webkit-details-marker]:hidden';

async function repointStoredParentBestEffort(parent: Prompt | null, from: string, to: string): Promise<Prompt | null> {
  if (!parent || parent.bundled) return null;
  const text = renameIncludes(parent.text, from, to);
  if (text === parent.text) return null;
  try {
    return await api.updatePrompt(parent.code, { description: parent.description, text });
  } catch (e) {
    toastError(e);
    return null;
  }
}

function IncludedPrompt({ parent, include }: { parent: Prompt | null; include: Prompt }) {
  const flow = usePromptsFlow();
  const { description, text } = flow.draftOf(include);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forkCode, setForkCode] = useState<string | null>(null);
  const dirty = unsavedChanges(include, { description, text }) > 0;
  const issues = localIssues({ text });

  const save = async (newCode?: string) => {
    setForkCode(null);
    setBusy(true);
    setError(null);
    try {
      if (newCode === undefined) return flow.afterIncludeSave(include.code, await api.updatePrompt(include.code, { description, text }), null);
      const copy = await api.createPrompt({ code: newCode, description, text });
      flow.afterIncludeSave(include.code, copy, await repointStoredParentBestEffort(parent, include.code, newCode));
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) setError(e.message);
      else toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details open data-included-prompt={include.code} className="group/include rounded-md border border-hairline bg-surface px-3">
      <summary className={DISCLOSURE}>
        <Icon name="chevron-down" className="size-3.5 -rotate-90 text-faint transition-transform group-open/include:rotate-0" />
        <span className="font-data font-semibold text-ink">{include.code}</span>
        <SourceBadge bundled={include.bundled} />
        {dirty && <span className="rounded-full bg-raised px-2 py-0.5 text-badge font-semibold uppercase tracking-[.06em] text-muted">Edited</span>}
      </summary>
      <div className="flex flex-col gap-2 pb-3">
        <TextBox
          id={`include-${include.code}`}
          text={text}
          bad={badSpans(text, issues)}
          invalid={issues.length > 0}
          compact
          onChange={(next) => {
            flow.setDraftOf(include, { text: next });
            setError(null);
          }}
        />
        {issues.map((issue, i) => (
          <ErrorBox key={i} issue={issue} />
        ))}
        {error && (
          <p role="alert" className="rounded-sm bg-fail-tint px-2.5 py-2 text-small text-fail">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {include.bundled && dirty && <span className="mr-auto text-small text-muted">Bundled: saving keeps your edit as a new prompt and points this one at it.</span>}
          <button type="button" className={SMALL_BTN} disabled={busy || !dirty} onClick={() => flow.discardOf(include.code)}>
            Discard
          </button>
          <button
            type="button"
            className={`${btnPrimary} ${SMALL}`}
            disabled={busy || !dirty || issues.length > 0}
            onClick={() => (include.bundled ? setForkCode(copyCode(include.code, flow.prompts)) : void save())}
          >
            Save
          </button>
        </div>
      </div>
      {forkCode !== null && (
        <SaveAsNewDialog
          bundled={include.code}
          code={forkCode}
          error={validateCode(forkCode, flow.prompts)}
          onChange={setForkCode}
          onSave={() => void save(forkCode)}
          onCancel={() => setForkCode(null)}
        />
      )}
    </details>
  );
}

const TICKET_FIELDS = ['title', 'body', 'labels', 'ref', 'origin'] as const;

type Picker = 'include' | 'ticket' | 'variable';

function InsertBar({ codes, onInsert }: { codes: readonly string[]; onInsert: (token: string) => void }) {
  const [open, setOpen] = useState<Picker | null>(null);
  const [variable, setVariable] = useState('');
  const toggle = (next: Picker) => setOpen((now) => (now === next ? null : next));
  const insert = (ref: string) => {
    onInsert('${{ ' + ref + ' }}');
    setOpen(null);
    setVariable('');
  };
  const pick = (ref: string) => (
    <button key={ref} type="button" className={`${SMALL_BTN} font-data`} onClick={() => insert(ref)}>
      {ref}
    </button>
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`${labelType} text-muted`}>Insert</span>
        <button type="button" className={SMALL_BTN} aria-expanded={open === 'include'} onClick={() => toggle('include')}>
          + Include prompt
        </button>
        <button type="button" className={SMALL_BTN} aria-expanded={open === 'ticket'} onClick={() => toggle('ticket')}>
          + Ticket field
        </button>
        <button type="button" className={SMALL_BTN} aria-expanded={open === 'variable'} onClick={() => toggle('variable')}>
          + Variable
        </button>
      </div>
      {open === 'include' && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Prompts to include">
          {codes.length === 0 ? <span className="text-small text-muted">No other prompts to include.</span> : codes.map((c) => pick(`prompts.${c}`))}
        </div>
      )}
      {open === 'ticket' && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Ticket fields">
          {TICKET_FIELDS.map((f) => pick(`ticket.${f}`))}
        </div>
      )}
      {open === 'variable' && (
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (variable.trim() !== '') insert(`vars.${variable.trim()}`);
          }}
        >
          <label className="flex items-center gap-1.5 text-small text-muted">
            <span className="font-data">vars.</span>
            <input value={variable} onChange={(e) => setVariable(e.target.value)} aria-label="Variable name" placeholder="name" className={`${field} !min-h-0 !py-1 font-data`} />
          </label>
          <button type="submit" className={SMALL_BTN} disabled={variable.trim() === ''}>
            Insert
          </button>
        </form>
      )}
    </div>
  );
}

function Source({ composed, failing, editor, insert }: { composed: boolean; failing: boolean; editor: React.ReactNode; insert: React.ReactNode }) {
  if (!composed) {
    return (
      <>
        <div>
          <label htmlFor="prompt-text" className={`${labelType} mb-1.5 block text-muted`}>
            Text
          </label>
          {editor}
        </div>
        {insert}
      </>
    );
  }
  return (
    <details className="group/source" open={failing || undefined}>
      <summary className={DISCLOSURE}>
        <Icon name="chevron-down" className="size-3.5 -rotate-90 text-faint transition-transform group-open/source:rotate-0" />
        <span className={`${labelType} text-muted`}>Source</span>
        <span className="text-small text-muted">Which prompts are included, and their order</span>
      </summary>
      <div className="flex flex-col gap-3.5 pb-1">
        <div>
          <label htmlFor="prompt-text" className="sr-only">
            Source
          </label>
          {editor}
        </div>
        {insert}
      </div>
    </details>
  );
}

function PromptEditForm() {
  const flow = usePromptsFlow();
  const { current: prompt, isNew, prompts, draft } = flow;
  const { code, description, text } = draft;
  const [serverIssue, setServerIssue] = useState<SaveIssue | null>(null);
  const [codeTouched, setCodeTouched] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  const codeError = isNew && (code !== '' || codeTouched) ? validateCode(code, prompts) : null;
  const codeIssue: SaveIssue | null = codeError
    ? { kind: 'code', field: 'code', message: codeError }
    : serverIssue?.field === 'code'
      ? serverIssue
      : null;
  const textIssues = [...localIssues({ text }), ...(serverIssue?.field === 'text' ? [serverIssue] : [])];
  const formIssue = serverIssue?.field === 'form' ? serverIssue : null;
  const errorCount = textIssues.length + (codeIssue ? 1 : 0) + (formIssue ? 1 : 0);
  const bad = badSpans(text, textIssues);

  const edit = (patch: Partial<typeof draft>) => {
    flow.setDraft(patch);
    setServerIssue(null);
  };

  const insertToken = (token: string) => {
    const el = areaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    edit({ text: text.slice(0, start) + token + text.slice(end) });
    el?.focus();
  };

  const otherCodes = prompts.filter((p) => p.code !== prompt?.code).map((p) => p.code);
  const includes = includedCodes(text).flatMap((c) => prompts.filter((p) => p.code === c && c !== prompt?.code));

  return (
    <section aria-label={isNew ? 'New prompt' : `Prompt ${prompt?.code ?? ''}`} className="flex min-w-0 flex-col gap-4">
      <PromptHeader blocked={errorCount > 0} onIssue={setServerIssue} onDiscarded={() => { setServerIssue(null); setCodeTouched(false); }} />

      {prompt?.bundled && (
        <div className="flex flex-wrap items-center gap-2.5 rounded-md bg-raised px-3 py-2.5">
          <b className="font-semibold">Bundled · ships with Harmonic</b>
          <span>Edit freely. Saving keeps your edit as a new prompt of your own and leaves this one unchanged.</span>
        </div>
      )}
      <PromptSends
        prompt={prompt}
        text={text}
        prompts={prompts}
        fields={
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div>
              <label htmlFor="prompt-code" className={`${labelType} mb-1.5 block text-muted`}>
                Code
              </label>
              <input
                id="prompt-code"
                value={code}
                readOnly={!isNew}
                onChange={(e) => {
                  setCodeTouched(true);
                  edit({ code: e.target.value });
                }}
                aria-invalid={codeIssue ? true : undefined}
                className={`${!isNew ? `${field} bg-sunken` : field} min-h-11 font-data ${codeIssue ? 'border-fail' : ''}`}
              />
              {codeIssue ? (
                <p role="alert" className="mt-1 text-small text-fail">
                  {issueMessage(codeIssue)}
                </p>
              ) : (
                <p className="mt-1 text-micro text-muted">Start with a letter; letters, digits, hyphens and underscores</p>
              )}
            </div>
            <div>
              <label htmlFor="prompt-description" className={`${labelType} mb-1.5 block text-muted`}>
                What it’s for
              </label>
              <input
                id="prompt-description"
                value={description}
                maxLength={500}
                onChange={(e) => edit({ description: e.target.value })}
                className={`${field} min-h-11`}
              />
              <p className="mt-1 text-micro text-muted">Shown in pickers and the list</p>
            </div>
          </div>
        }
        editor={
          <>
            <Source
              composed={includes.length > 0}
              failing={textIssues.length > 0 || formIssue !== null}
              insert={<InsertBar codes={otherCodes} onInsert={insertToken} />}
              editor={
                <>
                  <TextBox id="prompt-text" text={text} bad={bad} invalid={textIssues.length > 0} areaRef={areaRef} onChange={(next) => edit({ text: next })} />
                  {textIssues.map((issue, i) => (
                    <ErrorBox
                      key={i}
                      issue={issue}
                      onFix={
                        issue.kind === 'unknown' && issue.suggestion
                          ? () => edit({ text: applySuggestion(text, issue.code, issue.suggestion as string) })
                          : undefined
                      }
                    />
                  ))}
                  {formIssue && <ErrorBox issue={formIssue} />}
                  <p className="mt-1.5 text-micro text-muted">
                    Include a prompt with <code className="font-data">{'${{ prompts.code }}'}</code>. Context like <code className="font-data">{'${{ ticket.title }}'}</code> and{' '}
                    <code className="font-data">vars.name</code> fills in when the step runs.
                  </p>
                </>
              }
            />
            {includes.length > 0 && (
              <div className="flex flex-col gap-2" aria-label="Included prompts">
                <span className={`${labelType} text-muted`}>Included prompts</span>
                {includes.map((p) => (
                  <IncludedPrompt key={p.code} parent={prompt} include={p} />
                ))}
              </div>
            )}
          </>
        }
      />
      {errorCount > 0 && (
        <p className="text-small text-muted">
          Save is blocked while an error shows. Fix the {errorCount} {errorCount === 1 ? 'error' : 'errors'} above to enable it.
        </p>
      )}
    </section>
  );
}

export function PromptEditStep() {
  const { selected } = usePromptsFlow();
  return <PromptEditForm key={selected ?? ''} />;
}
