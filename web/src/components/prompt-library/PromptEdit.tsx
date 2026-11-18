import { useRef, useState } from 'react';
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
import { btnGhost, btnPrimary, btnQuietDestructive, field, labelType, quietTag } from '../../ui';
import { Icon } from '../Icon';
import { PromptTitle, SaveAsNewDialog, usePromptActions } from './PromptHeader';
import { usePromptsFlow } from './PromptsFlow';
import { PromptSends } from './PromptSends';

const CHIP_RESET = 'group-focus-within:px-0 group-focus-within:[font:inherit]';
const INC = `rounded-sm bg-tool-tint px-1 font-data text-[12.5px] text-tool ${CHIP_RESET}`;
const CTX = `rounded-sm bg-ready-tint px-1 font-data text-[12.5px] text-ready ${CHIP_RESET}`;
const BAD = `rounded-sm bg-fail-tint px-1 font-data text-[12.5px] text-fail underline decoration-fail decoration-wavy underline-offset-[3px] ${CHIP_RESET}`;
const BODY = 'font-data text-[13px] leading-[1.65]';

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
    <div className={`group relative overflow-hidden bg-field ${invalid ? 'ring-1 ring-inset ring-fail' : ''} ${compact ? 'min-h-[80px]' : 'min-h-[150px]'}`}>
      {lines.map((l, i) => (
        <div key={i} data-line={i + 1} className={`min-h-[21.5px] whitespace-pre-wrap break-words px-4 ${BODY} ${i === 0 ? 'pt-3' : ''} ${i === last ? 'pb-3' : ''}`}>
          <Segments segments={highlightLine(l, bad.filter((b) => b.line === i + 1))} />
        </div>
      ))}
      <textarea
        id={id}
        ref={areaRef}
        value={text}
        maxLength={100_000}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid ? true : undefined}
        spellCheck={false}
        className={`absolute inset-0 resize-none overflow-hidden whitespace-pre-wrap break-words border-0 bg-transparent px-4 py-3 text-transparent caret-ink focus:outline-none ${BODY}`}
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
const DISCLOSURE = 'flex min-h-9 cursor-pointer list-none items-center gap-2 px-4 py-2 text-small text-muted [&::-webkit-details-marker]:hidden';

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

  const tone = parent?.bundled ? 'bg-await-tint text-await' : 'bg-accent-tint text-accent';
  return (
    <details open data-included-prompt={include.code} className="group/include overflow-hidden rounded-md border border-hairline bg-surface">
      <summary className={`flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 [&::-webkit-details-marker]:hidden ${tone}`}>
        <Icon name="chevron-down" className="size-3.5 -rotate-90 transition-transform group-open/include:rotate-0" />
        <span className="font-data text-data font-semibold">{include.code}</span>
        <span className="min-w-0 flex-1 truncate text-small text-ink">{include.description}</span>
        {dirty && <span className={quietTag}>Edited</span>}
        <button type="button" className={`${SMALL_BTN} font-data`} onClick={() => flow.pick(include.code)}>
          Open in full editor →
        </button>
      </summary>
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
      {(issues.length > 0 || error) && (
        <div className="flex flex-col gap-1.5 px-3 pb-2">
          {issues.map((issue, i) => (
            <ErrorBox key={i} issue={issue} />
          ))}
          {error && (
            <p role="alert" className="rounded-sm bg-fail-tint px-2.5 py-2 text-small text-fail">
              {error}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 border-t border-hairline bg-sunken px-3 py-2">
        <button
          type="button"
          className={`${btnPrimary} ${SMALL}`}
          disabled={busy || !dirty || issues.length > 0}
          onClick={() => (include.bundled ? setForkCode(copyCode(include.code, flow.prompts)) : void save())}
        >
          Save
        </button>
        <button type="button" className={SMALL_BTN} disabled={busy || !dirty} onClick={() => flow.discardOf(include.code)}>
          Discard
        </button>
        {include.bundled && <span className="text-small text-muted">Bundled — saving keeps your edit as your own copy and points this include at it.</span>}
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

const INCLUDE_TOKEN = /\$\{\{\s*prompts\.([^\s}]+)\s*\}\}/g;

type Piece = { kind: 'text'; value: string } | { kind: 'include'; prompt: Prompt; token: string };

function splitIncludes(text: string, includes: readonly Prompt[]): Piece[] {
  const pieces: Piece[] = [];
  const placed = new Set<string>();
  let from = 0;
  for (const m of text.matchAll(INCLUDE_TOKEN)) {
    const include = includes.find((p) => p.code === m[1]);
    if (!include || placed.has(include.code)) continue;
    pieces.push({ kind: 'text', value: text.slice(from, m.index) }, { kind: 'include', prompt: include, token: m[0] });
    placed.add(include.code);
    from = m.index + m[0].length;
  }
  pieces.push({ kind: 'text', value: text.slice(from) });
  return pieces;
}

const joinPieces = (pieces: readonly Piece[]) => pieces.map((p) => (p.kind === 'text' ? p.value : p.token)).join('');

function Composed({ parent, text, includes, onChange }: { parent: Prompt | null; text: string; includes: readonly Prompt[]; onChange: (text: string) => void }) {
  const pieces = splitIncludes(text, includes);
  const edge = (i: number) => i === 0 || i === pieces.length - 1;
  return (
    <div aria-label="Included prompts" className="flex flex-col gap-3 px-3 py-3">
      {pieces.map((piece, i) => {
        if (piece.kind === 'include') return <IncludedPrompt key={piece.prompt.code} parent={parent} include={piece.prompt} />;
        const [, lead = '', core = '', trail = ''] = /^(\n*)([\s\S]*?)(\n*)$/.exec(piece.value) ?? [];
        if (core.trim() === '' && !edge(i)) return null;
        return (
          <div key={i} data-outer-text={i} className="overflow-hidden rounded-md border border-hairline">
            <TextBox
              id={`outer-text-${i}`}
              text={core}
              bad={[]}
              invalid={false}
              compact
              onChange={(next) => onChange(joinPieces(pieces.map((p, n) => (n === i ? { kind: 'text', value: lead + next + trail } : p))))}
            />
          </div>
        );
      })}
    </div>
  );
}

function Source({ composed, failing, editor, insert }: { composed: boolean; failing: boolean; editor: React.ReactNode; insert: React.ReactNode }) {
  if (!composed) {
    return (
      <>
        <label htmlFor="prompt-text" className="sr-only">
          Text
        </label>
        {editor}
        <div className="border-t border-hairline bg-sunken px-3 py-2">{insert}</div>
      </>
    );
  }
  return (
    <details className="group/source border-t border-hairline" open={failing || undefined}>
      <summary className={DISCLOSURE}>
        <Icon name="chevron-down" className="size-3.5 -rotate-90 text-faint transition-transform group-open/source:rotate-0" />
        <span>Edit source (which prompts are included)</span>
      </summary>
      <div className="flex flex-col gap-3 pb-3">
        <label htmlFor="prompt-text" className="sr-only">
          Source
        </label>
        {editor}
        <div className="px-3">{insert}</div>
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
  const actions = usePromptActions({
    blocked: errorCount > 0,
    onIssue: setServerIssue,
    onDiscarded: () => {
      setServerIssue(null);
      setCodeTouched(false);
    },
  });

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
  const composed = includes.length > 0;
  const bundled = prompt?.bundled === true;
  const aside = bundled ? (composed ? 'bundled · edit a part' : 'editable · saves a copy') : 'editable';
  const editable = !bundled && prompt !== null;

  const textEditor = (
    <>
      <TextBox id="prompt-text" text={text} bad={bad} invalid={textIssues.length > 0} areaRef={areaRef} onChange={(next) => edit({ text: next })} />
      {(textIssues.length > 0 || formIssue) && (
        <div className="flex flex-col gap-1.5 px-3">
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
        </div>
      )}
    </>
  );

  return (
    <section aria-label={isNew ? 'New prompt' : `Prompt ${prompt?.code ?? ''}`} className="flex min-w-0 flex-col gap-4">
      <PromptSends
        prompt={prompt}
        text={text}
        prompts={prompts}
        title={<PromptTitle />}
        aside={aside}
        fields={
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div>
              <label htmlFor="prompt-code" className={`${labelType} mb-1.5 block text-muted`}>
                Code
              </label>
              <div className="flex items-start gap-2">
                <input
                  id="prompt-code"
                  value={code}
                  readOnly={!isNew}
                  onChange={(e) => {
                    setCodeTouched(true);
                    edit({ code: e.target.value });
                  }}
                  aria-invalid={codeIssue ? true : undefined}
                  className={`${!isNew ? `${field} bg-sunken text-muted` : field} min-h-11 min-w-0 flex-1 font-data ${codeIssue ? 'border-fail' : ''}`}
                />
                {editable && (
                  <>
                    <button type="button" className={`${SMALL_BTN} !min-h-11`} disabled={actions.busy || actions.dirty} title={actions.dirty ? 'Save or discard your changes before renaming' : undefined} onClick={actions.askRename}>
                      Rename…
                    </button>
                    <button type="button" className={`${btnQuietDestructive} ${SMALL} !min-h-11`} disabled={actions.busy} onClick={actions.askDelete}>
                      Delete…
                    </button>
                  </>
                )}
              </div>
              {codeIssue ? (
                <p role="alert" className="mt-1 text-small text-fail">
                  {issueMessage(codeIssue)}
                </p>
              ) : (
                isNew && <p className="mt-1 text-micro text-muted">Start with a letter; letters, digits, hyphens and underscores</p>
              )}
            </div>
            <div>
              <label htmlFor="prompt-description" className={`${labelType} mb-1.5 block text-muted`}>
                What it’s for
              </label>
              <input id="prompt-description" value={description} maxLength={500} onChange={(e) => edit({ description: e.target.value })} className={`${field} min-h-11`} />
            </div>
          </div>
        }
        editor={
          <>
            {composed && <Composed parent={prompt} text={text} includes={includes} onChange={(next) => edit({ text: next })} />}
            <Source
              composed={composed}
              failing={textIssues.length > 0 || formIssue !== null}
              insert={<InsertBar codes={otherCodes} onInsert={insertToken} />}
              editor={textEditor}
            />
          </>
        }
        footer={
          (!composed || actions.dirty) && (
            <div data-testid="prompt-footer" className="flex flex-wrap items-center gap-3 border-t border-hairline bg-sunken px-3 py-2">
              <button type="button" className={`${btnPrimary} ${SMALL}`} disabled={actions.saveDisabled} onClick={actions.save}>
                Save
              </button>
              <button type="button" className={SMALL_BTN} disabled={actions.busy || !actions.dirty} onClick={actions.discard}>
                Discard changes
              </button>
              {bundled && <span className="text-small text-muted">This is a bundled prompt — saving keeps your edit as your own copy you can name.</span>}
            </div>
          )
        }
        notice={
          errorCount > 0 && (
            <p className="text-small text-muted">
              Save is blocked while an error shows. Fix the {errorCount} {errorCount === 1 ? 'error' : 'errors'} above to enable it.
            </p>
          )
        }
      />
      {actions.dialogs}
    </section>
  );
}

export function PromptEditStep() {
  const { selected } = usePromptsFlow();
  return <PromptEditForm key={selected ?? ''} />;
}
