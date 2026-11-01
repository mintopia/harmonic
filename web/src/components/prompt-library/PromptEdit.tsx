import { Fragment, useRef, useState } from 'react';
import {
  applySuggestion,
  badSpans,
  copyCode,
  highlightLine,
  localIssues,
  previewTree,
  validateCode,
  type BadSpan,
  type PreviewNode,
  type SaveIssue,
  type TextSegment,
} from '../../prompt-library-model';
import { btnGhost, field, labelType } from '../../ui';
import { Icon } from '../Icon';
import { PromptHeader } from './PromptHeader';
import { usePromptsFlow } from './PromptsFlow';

const CHIP_RESET = 'group-focus-within:px-0 group-focus-within:[font:inherit]';
const INC = `rounded-sm bg-tool-tint px-1 font-data text-[12.5px] text-tool ${CHIP_RESET}`;
const CTX = `rounded-sm bg-ready-tint px-1 font-data text-[12.5px] text-ready ${CHIP_RESET}`;
const BAD = `rounded-sm bg-fail-tint px-1 font-data text-[12.5px] text-fail underline decoration-fail decoration-wavy underline-offset-[3px] ${CHIP_RESET}`;
const PH = 'rounded-sm bg-ready-tint px-1 font-data text-[12px] text-ready';
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
  readOnly,
  areaRef,
  onChange,
}: {
  id: string;
  text: string;
  bad: readonly BadSpan[];
  invalid: boolean;
  readOnly: boolean;
  areaRef: React.RefObject<HTMLTextAreaElement | null>;
  onChange: (text: string) => void;
}) {
  const lines = text.split('\n');
  const last = lines.length - 1;
  return (
    <div
      className={`group relative grid grid-cols-[36px_1fr] content-start overflow-hidden rounded-md border ${
        invalid ? 'border-fail' : 'border-edge focus-within:border-accent'
      } ${readOnly ? 'bg-sunken' : 'min-h-[230px] bg-field'}`}
    >
      <div aria-hidden="true" className={`absolute inset-y-0 left-0 w-9 border-r border-hairline ${readOnly ? 'bg-raised' : 'bg-sunken'}`} />
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
      {readOnly ? (
        <div id={id} role="textbox" aria-readonly="true" aria-label="Text" className="absolute inset-0" />
      ) : (
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
      )}
    </div>
  );
}

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
        if (n.kind === 'context') return <span key={i} className={PH}>{n.value}</span>;
        const nested = n.depth > 1;
        return (
          <span
            key={i}
            data-include={n.code}
            className={`my-1.5 block rounded-r-sm border-l-[3px] px-2.5 py-1.5 ${nested ? 'border-await bg-await-tint' : 'border-accent bg-accent-tint'}`}
          >
            <span className={`mb-1 flex items-center gap-1.5 font-sans text-label font-semibold uppercase ${nested ? 'text-await' : 'text-accent'}`}>
              Included from <code className="font-data text-[11px] normal-case tracking-normal">{n.code}</code>
            </span>
            <Preview nodes={n.children} />
          </span>
        );
      })}
    </>
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

const TICKET_FIELDS = ['title', 'body', 'labels', 'ref', 'origin'] as const;
const SMALL_BTN = `${btnGhost} !min-h-0 !px-2.5 !py-1 !text-small`;

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

function PromptEditForm() {
  const flow = usePromptsFlow();
  const { current: prompt, isNew, prompts, draft } = flow;
  const readOnly = prompt?.bundled === true;
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

  const lookup = new Map(prompts.map((p) => [p.code, p.text]));
  if (prompt) lookup.set(prompt.code, text);
  const tree = previewTree(text, lookup, prompt ? [prompt.code] : []);

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

  const fieldClass = `${readOnly ? `${field} bg-sunken` : field} min-h-11`;
  const otherCodes = prompts.filter((p) => p.code !== prompt?.code).map((p) => p.code);

  return (
    <section aria-label={isNew ? 'New prompt' : `Prompt ${prompt?.code ?? ''}`} className="flex min-w-0 flex-col gap-4">
      <PromptHeader blocked={errorCount > 0} onIssue={setServerIssue} onDiscarded={() => { setServerIssue(null); setCodeTouched(false); }} />

      {readOnly && prompt && (
        <div className="flex flex-wrap items-center gap-2.5 rounded-md bg-raised px-3 py-2.5">
          <b className="font-semibold">Bundled · ships with Harmonic</b>
          <span>
            Read-only. Duplicate it to get an editable copy named <code className="font-data">{copyCode(prompt.code, prompts)}</code>.
          </span>
        </div>
      )}
      <div className={`grid grid-cols-1 gap-3.5 ${readOnly ? '' : 'xl:grid-cols-2 xl:items-start'}`}>
        <article className="flex flex-col gap-3.5 rounded-lg bg-surface p-[18px] shadow-card">
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
                !readOnly && <p className="mt-1 text-micro text-muted">Start with a letter; letters, digits, hyphens and underscores</p>
              )}
            </div>
            <div>
              <label htmlFor="prompt-description" className={`${labelType} mb-1.5 block text-muted`}>
                What it’s for
              </label>
              <input
                id="prompt-description"
                value={description}
                readOnly={readOnly}
                maxLength={500}
                onChange={(e) => edit({ description: e.target.value })}
                className={fieldClass}
              />
              {!readOnly && <p className="mt-1 text-micro text-muted">Shown in pickers and the list</p>}
            </div>
          </div>

          <div>
            <label htmlFor="prompt-text" className={`${labelType} mb-1.5 block text-muted`}>
              Text
            </label>
            <TextBox id="prompt-text" text={text} bad={bad} invalid={textIssues.length > 0} readOnly={readOnly} areaRef={areaRef} onChange={(next) => edit({ text: next })} />
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
            {!readOnly && (
              <p className="mt-1.5 text-micro text-muted">
                Include a prompt with <code className="font-data">{'${{ prompts.code }}'}</code>. Context like <code className="font-data">{'${{ ticket.title }}'}</code> and{' '}
                <code className="font-data">vars.name</code> fills in when the step runs.
              </p>
            )}
          </div>

          {!readOnly && <InsertBar codes={otherCodes} onInsert={insertToken} />}
          {!readOnly && errorCount > 0 && (
            <p className="text-small text-muted">
              Save is blocked while an error shows. Fix the {errorCount} {errorCount === 1 ? 'error' : 'errors'} above to enable it.
            </p>
          )}
        </article>

        {!readOnly && (
          <article aria-label="What the step sends" className="flex flex-col gap-2.5 rounded-lg bg-sunken p-[18px] shadow-card">
            <div className="flex items-center justify-between">
              <h3 className="text-title font-semibold text-ink">What a step sends</h3>
              <span className="text-micro text-muted">read-only</span>
            </div>
            <p className="text-small text-muted">This prompt with every include expanded. Updates as you type.</p>
            <div data-testid="include-preview" className={`rounded-sm border border-hairline bg-surface p-3 ${BODY}`}>
              <Preview nodes={tree} />
            </div>
            <div className="flex flex-wrap gap-3.5 text-micro text-muted">
              <span><i className="mr-1.5 inline-block size-2.5 rounded-sm bg-accent-tint shadow-[inset_3px_0_0_var(--color-accent)]" />included prompt</span>
              <span><i className="mr-1.5 inline-block size-2.5 rounded-sm bg-await-tint shadow-[inset_3px_0_0_var(--color-await)]" />nested include</span>
              <span><i className="mr-1.5 inline-block size-2.5 rounded-sm bg-ready-tint" /><span className="text-ready">blue</span> filled at run time</span>
            </div>
            <p className="text-small text-muted">A Critic step also gets the engine’s read-only guard and verdict contract. They aren’t shown here and can’t be edited.</p>
          </article>
        )}
      </div>

    </section>
  );
}

export function PromptEditStep() {
  const { selected } = usePromptsFlow();
  return <PromptEditForm key={selected ?? ''} />;
}
