import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { card, field, labelType } from '../ui';
import type { LabeledPreview, Placeholder } from '../prompt-preview-model';

export function SettingsSection({
  title,
  description,
  className,
  children,
}: {
  title: string;
  description: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`${card} p-5${className ? ` ${className}` : ''}`}>
      <h2 className="text-title font-semibold">{title}</h2>
      <p className="mb-4 mt-0.5 text-muted">{description}</p>
      {children}
    </section>
  );
}

export const fieldLabel = `mb-1.5 block ${labelType} text-muted`;

const chipBase =
  'rounded-md border px-1.5 py-1 font-data text-small leading-none transition-colors focus:outline-none focus-visible:border-accent';

/** The always-available Task-identity tokens ({@link Placeholder.core}) render
 * first in the accent voice; context tokens follow after a hairline. Clicking a
 * chip inserts its token at the editor's caret. Shared by every prompt editor so
 * the "Insert" row reads the same on Drive, Task, Critic and Epic-resolve. */
export function PlaceholderChips({
  placeholders,
  onInsert,
}: {
  placeholders: Placeholder[];
  onInsert: (token: string) => void;
}) {
  const core = placeholders.filter((p) => p.core);
  const context = placeholders.filter((p) => !p.core);
  const chip = (p: Placeholder) => (
    <button
      key={p.token}
      type="button"
      title={p.desc}
      className={`${chipBase} ${
        p.core
          ? 'border-transparent bg-accent-tint text-accent hover:border-accent'
          : 'border-edge bg-surface text-muted hover:border-accent hover:text-accent'
      }`}
      onClick={() => onInsert(p.token)}
    >
      {p.token}
    </button>
  );
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className={`${labelType} text-faint`}>Insert</span>
      {core.map(chip)}
      {core.length > 0 && context.length > 0 && <span className="mx-0.5 h-4 w-px self-center bg-hairline" />}
      {context.map(chip)}
    </div>
  );
}

const previewPane = 'mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-raised p-2.5 text-small text-ink';

/** The compiled prompt under a prompt editor: a single pane for one string, or —
 * when the same template compiles differently per Task kind — the labeled
 * variants laid out side by side so the operator can compare them. */
export function PromptPreview({ text }: { text: string | LabeledPreview[] }) {
  return (
    <details className="mt-2">
      <summary className={`cursor-pointer ${labelType} text-muted`}>Compiled preview</summary>
      {typeof text === 'string' ? (
        <pre className={previewPane}>{text}</pre>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {text.map((variant) => (
            <div key={variant.label} className="min-w-0">
              <div className={`mt-1.5 ${labelType} text-muted`}>{variant.label}</div>
              <pre className={previewPane}>{variant.text}</pre>
            </div>
          ))}
        </div>
      )}
    </details>
  );
}

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1 text-label text-fail">{message}</p>;
}

/**
 * One prompt-template textarea with its placeholder legend and compiled preview
 * (the `{token}` help + the "Compiled preview" pane). Shared by both settings
 * surfaces so the drive/task/review prompt editors are written once: the global
 * page passes a `label`; the workspace page omits it (its `InheritField` wrapper
 * supplies the label) and drives it from the override slot. `preview` is
 * precomputed by the caller (via the `compile*Preview` helpers) so this stays a
 * dumb presentational field.
 */
export function PromptField({
  id,
  label,
  description,
  value,
  onChange,
  placeholders,
  preview,
  error,
  rows,
  textareaClass = field,
}: {
  id: string;
  /** Omit when a wrapper (e.g. InheritField) already renders the label. */
  label?: string;
  description?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholders: Placeholder[];
  preview: string | LabeledPreview[];
  error?: string;
  rows?: number;
  textareaClass?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingCaret.current === null || !taRef.current) return;
    const at = pendingCaret.current;
    pendingCaret.current = null;
    taRef.current.focus();
    taRef.current.setSelectionRange(at, at);
  });
  const insert = (token: string) => {
    const el = taRef.current;
    const start = el ? el.selectionStart : value.length;
    const end = el ? el.selectionEnd : value.length;
    pendingCaret.current = start + token.length;
    onChange(value.slice(0, start) + token + value.slice(end));
  };
  return (
    <div>
      {label && (
        <label className={fieldLabel} htmlFor={id}>
          {label}
        </label>
      )}
      {description && <p className="mb-1 text-small text-muted">{description}</p>}
      <PlaceholderChips placeholders={placeholders} onInsert={insert} />
      <textarea
        ref={taRef}
        id={id}
        rows={rows}
        className={`${textareaClass} mt-1.5`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <FieldError message={error} />
      <PromptPreview text={preview} />
    </div>
  );
}

/** Server validation errors arrive as one `path: message; path: message`
 * string (src/server/app.ts's error handler) — split it back into a per-field
 * map, so a settings form can surface each at its field via {@link FieldError},
 * falling back to the whole string for anything unmapped. Shared by the global
 * and per-Workspace settings pages. */
/** Rewrite the terse validator messages (mostly Zod's) into plain English. A
 * message that is already human — a custom schema message, a domain error — has
 * no pattern to match and passes through unchanged. */
export function humanizeFieldMessage(message: string): string {
  const m = message.trim();
  let g: RegExpMatchArray | null;
  if (/^too small:.*string.*(>=?\s*1|at least\s*1)\b/i.test(m) || /^required$/i.test(m)) return 'Required';
  if ((g = m.match(/^too small:.*string.*?(\d+)\s*character/i))) return `Must be at least ${g[1]} characters`;
  if ((g = m.match(/^too small:.*number.*?(\d+)/i))) return `Must be at least ${g[1]}`;
  if ((g = m.match(/^too big:.*number.*?(\d+)/i))) return `Must be at most ${g[1]}`;
  if ((g = m.match(/^too big:.*string.*?(\d+)\s*character/i))) return `Must be at most ${g[1]} characters`;
  if (/^invalid input:.*expected string/i.test(m)) return 'Must be text';
  if (/^invalid input:.*expected number/i.test(m)) return 'Must be a number';
  if (/^invalid input:.*expected boolean/i.test(m)) return 'Must be true or false';
  if (/^invalid (option|enum|union)/i.test(m)) return 'Not one of the allowed values';
  if (/^invalid input$/i.test(m)) return 'Invalid value';
  return m;
}

/** Server validation errors arrive as one `path: message; path: message`
 * string (src/server/app.ts's error handler) — split it back into a per-field
 * map, so a settings form can surface each at its field via {@link FieldError},
 * falling back to the whole string for anything unmapped. Values are run through
 * {@link humanizeFieldMessage} so both the inline errors and the save bar read
 * plainly. Shared by the global and per-Workspace settings pages. */
export function parseFieldErrors(message: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of message.split('; ')) {
    const i = part.indexOf(': ');
    if (i === -1) continue;
    out[part.slice(0, i)] = humanizeFieldMessage(part.slice(i + 2));
  }
  return out;
}

/** Human labels for the dotted config-path segments the server error handler
 * emits, so a validation error names the field an operator recognises instead of
 * its schema path. Unlisted segments fall back to de-camel-cased Title Case. */
const FIELD_SEGMENT_LABELS: Record<string, string> = {
  harnesses: 'Harness',
  verify: 'Verification',
  guardrails: 'Guardrails',
  drive: 'Auto-drive',
  defaults: 'Defaults',
  chat: 'Chat',
  autoRunner: 'Auto-runner',
  editor: 'Editor',
  task: 'Task',
  epic: 'Epic',
  preMerge: 'Pre-merge',
  postMerge: 'Post-merge',
  commands: 'Command',
  critics: 'Critic',
  budget: 'Budget',
  models: 'Model',
  defaultModel: 'Default model',
  cacheWarmSeconds: 'Cache warm (s)',
  permissionMode: 'Permission mode',
  sessionLogDir: 'Session log dir',
  timeoutSeconds: 'Timeout (s)',
  issuePrompt: 'Issue prompt',
  noIssuePrompt: 'No-issue prompt',
  maxConcurrentAttempts: 'Concurrency cap',
  maxAttempts: 'Attempt limit',
  contextReuseTokenLimit: 'Context reuse limit',
  wallClockMinutes: 'Wall-clock (min)',
  costUsd: 'Cost cap (USD)',
  toolTimeoutMinutes: 'Tool timeout (min)',
  conflictResolveTurns: 'Conflict-resolve turns',
  isolationMode: 'Isolation mode',
  mergeFate: 'Merge fate',
  continueAttempts: 'Continue attempts',
  unattendedReminder: 'Unattended reminder',
  continuePrompt: 'Continue prompt',
  taskPrompt: 'Task prompt',
  pauseMessage: 'Pause message',
};

function humanizeSegment(seg: string): string {
  if (/^\d+$/.test(seg)) return `#${Number(seg) + 1}`;
  return (
    FIELD_SEGMENT_LABELS[seg] ??
    seg
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]/g, ' ')
      .replace(/^./, (c) => c.toUpperCase())
  );
}

/** Turn a dotted config path (`verify.task.preMerge.commands.0.command`) into a
 * readable "Field (context)" label ("Command (Verification · Task · Pre-merge · #1)"). */
export function humanizeFieldPath(path: string): string {
  const segs = path.split('.').filter(Boolean);
  if (segs.length === 0) return path;
  const leaf = humanizeSegment(segs[segs.length - 1]!);
  const context = segs.slice(0, -1).map(humanizeSegment);
  return context.length ? `${leaf} (${context.join(' · ')})` : leaf;
}

/** Turn a raw save-error message into human-readable text for the save bar. A
 * field-validation string ("path: msg; path: msg") becomes readable field lines;
 * any other message (a domain error, "internal server error") is already human
 * and passes through unchanged. */
export function humanizeSaveError(message: string): string {
  const fields = parseFieldErrors(message);
  const keys = Object.keys(fields);
  if (keys.length === 0) return message;
  if (keys.length === 1) return `${humanizeFieldPath(keys[0]!)} — ${fields[keys[0]!]}`;
  return `${keys.length} settings need fixing:\n` + keys.map((k) => `• ${humanizeFieldPath(k)} — ${fields[k]}`).join('\n');
}
