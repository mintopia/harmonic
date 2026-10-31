import { Fragment, useState } from 'react';
import { ApiError, api } from '../../api';
import { toastError } from '../../toast';
import {
  applySuggestion,
  badSpans,
  copyCode,
  editedLabel,
  highlightLine,
  localIssues,
  parseSaveError,
  previewTree,
  validateCode,
  usedByRows,
  type BadSpan,
  type PreviewNode,
  type SaveIssue,
  type TextSegment,
} from '../../prompt-library-model';
import type { Prompt } from '../../types';
import { btnGhost, btnPrimary, btnQuietDestructive, field, labelType } from '../../ui';
import { ConfirmDialog } from '../ConfirmDialog';
import { Icon } from '../Icon';
import { SourceBadge } from './SourceBadge';

const CHIP_RESET = 'group-focus-within:px-0 group-focus-within:[font:inherit]';
const INC = `rounded-sm bg-tool-tint px-1 font-data text-[12.5px] text-tool ${CHIP_RESET}`;
const CTX = `rounded-sm bg-ready-tint px-1 font-data text-[12.5px] text-ready ${CHIP_RESET}`;
const BAD = `rounded-sm bg-fail-tint px-1 font-data text-[12.5px] text-fail underline decoration-fail decoration-wavy underline-offset-[3px] ${CHIP_RESET}`;
const PH = 'rounded-sm bg-ready-tint px-1 font-data text-[12px] text-ready';
const LINK = 'whitespace-nowrap text-small font-semibold text-accent underline underline-offset-2';
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
  onChange,
}: {
  id: string;
  text: string;
  bad: readonly BadSpan[];
  invalid: boolean;
  readOnly: boolean;
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
        <div id={id} role="textbox" aria-readonly="true" className="absolute inset-0" />
      ) : (
        <textarea
          id={id}
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

export function PromptEditor({
  prompt,
  prompts,
  onSaved,
  onDeleted,
  onDuplicated,
  onOpen,
  onClose,
}: {
  prompt: Prompt | null;
  prompts: readonly Prompt[];
  onSaved: (saved: Prompt) => void;
  onDeleted: () => void;
  onDuplicated: (copy: Prompt) => void;
  onOpen: (code: string) => void;
  onClose: () => void;
}) {
  const isNew = prompt === null;
  const readOnly = prompt?.bundled === true;
  const [code, setCode] = useState(prompt?.code ?? '');
  const [description, setDescription] = useState(prompt?.description ?? '');
  const [text, setText] = useState(prompt?.text ?? '');
  const [serverIssue, setServerIssue] = useState<SaveIssue | null>(null);
  const [codeTouched, setCodeTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const dirty = isNew ? code !== '' || description !== '' || text !== '' : description !== prompt.description || text !== prompt.text;
  const codeError = isNew && (code !== '' || codeTouched) ? validateCode(code, prompts) : null;
  const codeIssue: SaveIssue | null = codeError
    ? { kind: 'code', field: 'code', message: codeError }
    : serverIssue?.field === 'code'
      ? serverIssue
      : null;
  const textIssues = [...localIssues({ text }), ...(serverIssue?.field === 'text' ? [serverIssue] : [])];
  const formIssue = serverIssue?.field === 'form' ? serverIssue : null;
  const errorCount = textIssues.length + (codeIssue ? 1 : 0) + (formIssue ? 1 : 0);
  const saveDisabled = busy || errorCount > 0 || !dirty || (isNew && (code === '' || validateCode(code, prompts) !== null));
  const bad = badSpans(text, textIssues);

  const lookup = new Map(prompts.map((p) => [p.code, p.text]));
  if (!isNew) lookup.set(prompt.code, text);
  const tree = previewTree(text, lookup, isNew ? [] : [prompt.code]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setServerIssue(null);
    try {
      const saved = isNew ? await api.createPrompt({ code, description, text }) : await api.updatePrompt(prompt.code, { description, text });
      onSaved(saved);
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        setServerIssue(parseSaveError(e.message, text, prompts.map((p) => p.code)));
      } else toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setConfirmDelete(false);
    if (isNew) return;
    setBusy(true);
    try {
      await api.deletePrompt(prompt.code);
      onDeleted();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const duplicate = () => {
    if (isNew) return;
    void run(async () => onDuplicated(await api.duplicatePrompt(prompt.code, copyCode(prompt.code, prompts))));
  };

  const rows = prompt ? usedByRows(prompt, prompts) : [];
  const edited = prompt ? editedLabel(prompt.updatedAt) : null;
  const fieldRo = `${field} min-h-11 bg-sunken`;

  return (
    <section aria-label={isNew ? 'New prompt' : `Prompt ${prompt.code}`} className="mt-4 border-t border-hairline pt-4">
      <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
        <h4 className="text-title font-semibold text-ink">{isNew ? 'New prompt' : prompt.code}</h4>
        {!isNew && <SourceBadge bundled={prompt.bundled} />}
        {edited && <span className="text-small text-muted">{edited}</span>}
        <span className="flex-1" />
        <button type="button" className="text-muted hover:text-ink" onClick={onClose}>
          Close
        </button>
      </div>

      {readOnly && (
        <div className="mb-3.5 flex flex-wrap items-center gap-2.5 rounded-sm bg-raised px-3 py-2.5">
          <b className="font-semibold">Bundled · ships with Harmonic</b>
          <span>
            Read-only. Duplicate it to get an editable copy named <code className="font-data">{copyCode(prompt.code, prompts)}</code>.
          </span>
          <span className="flex-1" />
          <button type="button" className={btnPrimary} onClick={duplicate} disabled={busy}>
            Duplicate
          </button>
        </div>
      )}

      <div className={`grid grid-cols-1 gap-4 ${readOnly ? '' : 'xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] xl:items-start'}`}>
        <div>
          <div className="mb-3.5">
            <label htmlFor="prompt-code" className={`${labelType} mb-1.5 block text-muted`}>
              Code
            </label>
            <input
              id="prompt-code"
              value={code}
              readOnly={!isNew}
              onChange={(e) => {
                setCode(e.target.value);
                setCodeTouched(true);
                setServerIssue(null);
              }}
              aria-invalid={codeIssue ? true : undefined}
              className={`${readOnly ? fieldRo : field} min-h-11 font-data ${codeIssue ? 'border-fail' : ''}`}
            />
            {codeIssue ? (
              <p role="alert" className="mt-1 text-[10px] leading-[1.3] text-fail">
                {issueMessage(codeIssue)}
              </p>
            ) : (
              !readOnly && <p className="mt-1 text-small text-muted">Unique. Start with a letter; letters, digits, hyphens and underscores.</p>
            )}
          </div>
          <div className="mb-3.5">
            <label htmlFor="prompt-description" className={`${labelType} mb-1.5 block text-muted`}>
              Description
            </label>
            <input
              id="prompt-description"
              value={description}
              readOnly={readOnly}
              maxLength={500}
              onChange={(e) => setDescription(e.target.value)}
              className={`${readOnly ? fieldRo : field} min-h-11`}
            />
            {!readOnly && <p className="mt-1 text-small text-muted">What this prompt is for.</p>}
          </div>

          <label htmlFor="prompt-text" className={`${labelType} mb-1.5 block text-muted`}>
            Text
          </label>
          <TextBox
            id="prompt-text"
            text={text}
            bad={bad}
            invalid={textIssues.length > 0}
            readOnly={readOnly}
            onChange={(next) => {
              setText(next);
              setServerIssue(null);
            }}
          />
          {textIssues.map((issue, i) => (
            <ErrorBox
              key={i}
              issue={issue}
              onFix={
                issue.kind === 'unknown' && issue.suggestion
                  ? () => {
                      setText(applySuggestion(text, issue.code, issue.suggestion as string));
                      setServerIssue(null);
                    }
                  : undefined
              }
            />
          ))}
          {formIssue && <ErrorBox issue={formIssue} />}
          {!readOnly && (
          <p className="mt-1 text-small text-muted">
            Include another prompt with <code className="font-data">{'${{ prompts.code }}'}</code>. Context values such as{' '}
            <code className="font-data">{'${{ ticket.title }}'}</code> and <code className="font-data">{'${{ vars.name }}'}</code> are filled in when a Step runs.
          </p>
          )}

          {readOnly ? (
            <p className="mt-2 text-small text-faint">No Save or Delete on a Bundled prompt. The Used by list is still shown, so you can see what a Duplicate could replace.</p>
          ) : (
            <>
              <div className="mt-4 flex flex-wrap items-center gap-2.5">
                <button type="button" className={btnPrimary} disabled={saveDisabled} onClick={() => void save()}>
                  Save
                </button>
                <button
                  type="button"
                  className={btnGhost}
                  disabled={busy || !dirty}
                  onClick={() => {
                    setCode(prompt?.code ?? '');
                    setDescription(prompt?.description ?? '');
                    setText(prompt?.text ?? '');
                    setServerIssue(null);
                  }}
                >
                  Discard changes
                </button>
                {errorCount > 0 && (
                  <span className="text-small text-muted">
                    Save is blocked while an error shows. Fix the {errorCount} {errorCount === 1 ? 'error' : 'errors'} above to enable it.
                  </span>
                )}
                <span className="flex-1" />
                {!isNew && (
                  <button type="button" className={btnQuietDestructive} disabled={busy} onClick={() => setConfirmDelete(true)}>
                    Delete…
                  </button>
                )}
              </div>
              {actionError && (
                <p role="alert" className="mt-2 rounded-sm bg-fail-tint px-2.5 py-2 text-small text-fail">
                  {actionError}
                </p>
              )}
              <p className="mt-2 text-small text-faint">Editing a prompt affects the next execution, never one already sent. Resolved Prompts are archived as sent.</p>
            </>
          )}
        </div>

        {!readOnly && (
        <div className="rounded-md border border-hairline bg-sunken p-3.5">
          <h5 className="text-small font-semibold text-ink">Include preview</h5>
          <p className="mb-2.5 text-small text-muted">The text a Step sends, with includes expanded.</p>
          <div data-testid="include-preview" className={`rounded-sm border border-hairline bg-surface px-3 py-2.5 ${BODY}`} >
            <Preview nodes={tree} />
          </div>
          <div className="mt-2.5 flex flex-wrap gap-3.5 text-small text-muted">
            <span><i className="mr-1.5 inline-block size-2.5 rounded-sm bg-accent-tint shadow-[inset_3px_0_0_var(--color-accent)]" />Included prompt</span>
            <span><i className="mr-1.5 inline-block size-2.5 rounded-sm bg-await-tint shadow-[inset_3px_0_0_var(--color-await)]" />Nested include</span>
            <span><i className="mr-1.5 inline-block size-2.5 rounded-sm bg-ready-tint" />Filled in at run time</span>
          </div>
          <p className="mt-2 text-small text-faint">
            Includes make a prompt’s sent text differ from what its entry shows; the Resolved Prompt in the transcript remains the record of what was sent.
          </p>
        </div>
        )}
      </div>

      {!isNew && (
        <div className="mt-5 border-t border-hairline pt-4">
          <h4 className="text-title font-semibold text-ink">Used by</h4>
          <p className="mb-2.5 text-small text-muted">Check these before you change the text. Edits apply to their next execution.</p>
          {rows.length === 0 ? (
            <p className="text-muted">Nothing uses this prompt yet.</p>
          ) : (
            <ul className="flex list-none flex-col gap-1.5 p-0">
              {rows.map((row) => (
                <li
                  key={row.kind === 'step' ? `step:${row.workflow}:${row.stepId}` : `prompt:${row.code}`}
                  data-used-by={row.kind}
                  className="flex min-h-11 items-center gap-2.5 rounded-md bg-surface px-3 py-[9px] shadow-card"
                >
                  <span className={`${labelType} w-[78px] shrink-0 text-faint`}>{row.kind === 'step' ? 'Step' : 'Prompt'}</span>
                  {row.kind === 'step' ? (
                    <>
                      <span className="min-w-0 flex-1">
                        {row.workflow} · step <code className="font-data text-[12.5px]">{row.stepId}</code>
                        <span className="block text-small text-muted">Task Execution Workflow, {row.bundled ? 'Bundled' : 'yours'}</span>
                      </span>
                      <a href="/settings" className={LINK}>
                        Open workflow
                      </a>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1">
                        Prompt <code className="font-data text-[12.5px]">{row.code}</code>
                        <span className="block text-small text-muted">
                          Includes <code className="font-data text-[12.5px]">{prompt?.code}</code>
                          {row.line !== null && ` on line ${row.line}`}
                        </span>
                      </span>
                      <button type="button" onClick={() => onOpen(row.code)} className={LINK}>
                        Open prompt
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {confirmDelete && !isNew && (
        <ConfirmDialog
          label="Delete prompt"
          title={`Delete ${prompt.code}?`}
          confirmLabel="Delete prompt"
          tone="danger"
          onConfirm={() => void remove()}
          onCancel={() => setConfirmDelete(false)}
        >
          This removes the prompt from the Library. A prompt that other prompts include cannot be deleted.
        </ConfirmDialog>
      )}
    </section>
  );
}

