import { useState } from 'react';
import { ApiError, api } from '../../api';
import { toastError } from '../../toast';
import {
  applySuggestion,
  copyCode,
  highlightLine,
  includeLine,
  localIssues,
  parseSaveError,
  previewTree,
  validateCode,
  type PreviewNode,
  type SaveIssue,
  type TextSegment,
} from '../../prompt-library-model';
import type { Prompt } from '../../types';
import { btnGhost, btnPrimary, btnQuietDestructive, field, labelType } from '../../ui';
import { ConfirmDialog } from '../ConfirmDialog';
import { Icon } from '../Icon';
import { SourceBadge } from './SourceBadge';

const INC = 'rounded-sm bg-tool-tint px-1 font-data text-tool';
const CTX = 'rounded-sm bg-ready-tint px-1 font-data text-ready';

function Segments({ segments }: { segments: readonly TextSegment[] }) {
  return (
    <>
      {segments.map((s, i) =>
        s.kind === 'text' ? <span key={i}>{s.value}</span> : <span key={i} className={s.kind === 'include' ? INC : CTX}>{s.value}</span>,
      )}
    </>
  );
}

function Gutter({ lines, badLine }: { lines: number; badLine: number | null }) {
  return (
    <div aria-hidden="true" className="select-none border-r border-hairline bg-sunken py-2.5 pr-1.5 text-right font-data text-small text-faint" style={{ lineHeight: '1.65rem' }}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className={badLine === i + 1 ? 'font-semibold text-fail' : undefined}>
          {i + 1}
        </div>
      ))}
    </div>
  );
}

function Preview({ nodes }: { nodes: readonly PreviewNode[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        if (n.kind === 'text') return <span key={i} className="whitespace-pre-wrap">{n.value}</span>;
        if (n.kind === 'context') return <span key={i} className={CTX}>{n.value}</span>;
        const nested = n.depth > 1;
        return (
          <span
            key={i}
            data-include={n.code}
            className={`my-1.5 block rounded-r-sm border-l-[3px] px-2.5 py-1.5 ${nested ? 'border-await bg-await-tint' : 'border-accent bg-accent-tint'}`}
          >
            <span className={`mb-1 flex items-center gap-1.5 text-label font-semibold uppercase ${nested ? 'text-await' : 'text-accent'}`}>
              Included from <code className="font-data normal-case">{n.code}</code>
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
    default:
      return issue.message;
  }
}

function ErrorBox({ issue, onFix }: { issue: SaveIssue; onFix?: () => void }) {
  return (
    <div role="alert" data-issue={issue.kind} className="mt-1.5 flex items-start gap-2 rounded-sm bg-fail-tint px-2.5 py-2 text-small text-fail">
      <Icon name="alert-triangle" className="mt-0.5 size-3.5 shrink-0" />
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
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const dirty = isNew ? code !== '' || description !== '' || text !== '' : description !== prompt.description || text !== prompt.text;
  const codeError = isNew && code !== '' ? validateCode(code, prompts) : null;
  const codeIssue: SaveIssue | null = codeError
    ? { kind: 'code', field: 'code', message: codeError }
    : serverIssue?.field === 'code'
      ? serverIssue
      : null;
  const textIssues = [...localIssues({ text }), ...(serverIssue?.field === 'text' ? [serverIssue] : [])];
  const formIssue = serverIssue?.field === 'form' ? serverIssue : null;
  const errorCount = textIssues.length + (codeIssue ? 1 : 0) + (formIssue ? 1 : 0);
  const saveDisabled = busy || errorCount > 0 || !dirty || (isNew && (code === '' || validateCode(code, prompts) !== null));
  const badLine = textIssues.map((i) => ('position' in i ? i.position?.line : null)).find((l) => l != null) ?? null;

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

  const lines = text.split('\n');
  const usedBy = prompt?.usedBy ?? [];
  const fieldRo = `${field} min-h-11 bg-sunken`;

  return (
    <section aria-label={isNew ? 'New prompt' : `Prompt ${prompt.code}`} className="mt-4 border-t border-hairline pt-4">
      <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
        <h4 className="text-title font-semibold text-ink">{isNew ? 'New prompt' : prompt.code}</h4>
        {!isNew && <SourceBadge bundled={prompt.bundled} />}
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

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] xl:items-start">
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
                setServerIssue(null);
              }}
              aria-invalid={codeIssue ? true : undefined}
              className={`${!isNew ? fieldRo : field} min-h-11 font-data ${codeIssue ? 'border-fail' : ''}`}
            />
            {codeIssue ? (
              <p role="alert" className="mt-1 text-meta text-fail">
                {issueMessage(codeIssue)}
              </p>
            ) : (
              isNew && <p className="mt-1 text-small text-muted">Unique. Start with a letter; letters, digits, hyphens and underscores.</p>
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
          <div
            className={`grid grid-cols-[36px_1fr] overflow-hidden rounded-md border bg-field ${textIssues.length > 0 ? 'border-fail' : 'border-edge'} ${
              readOnly ? 'bg-sunken' : ''
            }`}
          >
            <Gutter lines={lines.length} badLine={badLine} />
            {readOnly ? (
              <div id="prompt-text" role="textbox" aria-readonly="true" className="px-3 py-2.5" style={{ lineHeight: '1.65rem' }}>
                {lines.map((l, i) => (
                  <span key={i} className="block min-h-[1.65rem] whitespace-pre-wrap">
                    <Segments segments={highlightLine(l)} />
                  </span>
                ))}
              </div>
            ) : (
              <textarea
                id="prompt-text"
                value={text}
                rows={Math.max(8, lines.length)}
                maxLength={100_000}
                onChange={(e) => {
                  setText(e.target.value);
                  setServerIssue(null);
                }}
                aria-invalid={textIssues.length > 0 ? true : undefined}
                className="w-full resize-y border-0 bg-transparent px-3 py-2.5 text-ink focus:outline-none"
                style={{ lineHeight: '1.65rem' }}
              />
            )}
          </div>
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
          <p className="mt-1 text-small text-muted">
            Include another prompt with <code className="font-data">{'${{ prompts.code }}'}</code>. Context values such as{' '}
            <code className="font-data">{'${{ ticket.title }}'}</code> and <code className="font-data">{'${{ vars.name }}'}</code> are filled in when a Step runs.
          </p>

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

        <div className="rounded-md border border-hairline bg-sunken p-3.5">
          <h5 className="text-small font-semibold text-ink">Include preview</h5>
          <p className="mb-2.5 text-small text-muted">The text a Step sends, with includes expanded.</p>
          <div data-testid="include-preview" className="rounded-sm border border-hairline bg-surface px-3 py-2.5" style={{ lineHeight: '1.65rem' }}>
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
      </div>

      {!isNew && (
        <div className="mt-5 border-t border-hairline pt-4">
          <h4 className="text-title font-semibold text-ink">Used by</h4>
          <p className="mb-2.5 text-small text-muted">Check these before you change the text. Edits apply to their next execution.</p>
          {usedBy.length === 0 ? (
            <p className="text-muted">No other prompt includes this one.</p>
          ) : (
            <ul className="flex list-none flex-col gap-1.5 p-0">
              {usedBy.map((other) => {
                const line = includeLine(prompts.find((p) => p.code === other)?.text ?? '', prompt.code);
                return (
                  <li key={other} className="flex min-h-11 items-center gap-2.5 rounded-md bg-surface px-3 py-2 shadow-card">
                    <span className={`${labelType} w-20 shrink-0 text-faint`}>Prompt</span>
                    <span className="min-w-0 flex-1">
                      Prompt <code className="font-data">{other}</code>
                      <span className="block text-small text-muted">
                        Includes <code className="font-data">{prompt.code}</code>
                        {line !== null && ` on line ${line}`}
                      </span>
                    </span>
                    <button type="button" onClick={() => onOpen(other)} className="text-small font-semibold text-accent underline underline-offset-2">
                      Open prompt
                    </button>
                  </li>
                );
              })}
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

