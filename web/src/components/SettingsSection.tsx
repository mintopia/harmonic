import type { ReactNode } from 'react';
import { card, field, labelType } from '../ui';

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className={`${card} p-5`}>
      <h2 className="text-title font-semibold">{title}</h2>
      <p className="mb-4 mt-0.5 text-muted">{description}</p>
      {children}
    </section>
  );
}

export const fieldLabel = `mb-1.5 block ${labelType} text-muted`;

export function PlaceholderList({ placeholders }: { placeholders: [string, string][] }) {
  return (
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small text-muted">
      {placeholders.map(([token, desc]) => (
        <div key={token} className="contents">
          <dt className="font-data text-ink">{token}</dt>
          <dd>{desc}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PromptPreview({ text }: { text: string }) {
  return (
    <details className="mt-2">
      <summary className={`cursor-pointer ${labelType} text-muted`}>Compiled preview</summary>
      <pre className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-raised p-2.5 text-small text-ink">
        {text}
      </pre>
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
  placeholders: [string, string][];
  preview: string;
  error?: string;
  rows?: number;
  textareaClass?: string;
}) {
  return (
    <div>
      {label && (
        <label className={fieldLabel} htmlFor={id}>
          {label}
        </label>
      )}
      {description && <p className="mb-1 text-small text-muted">{description}</p>}
      <textarea id={id} rows={rows} className={textareaClass} value={value} onChange={(e) => onChange(e.target.value)} />
      <FieldError message={error} />
      <PlaceholderList placeholders={placeholders} />
      <PromptPreview text={preview} />
    </div>
  );
}

/** Server validation errors arrive as one `path: message; path: message`
 * string (src/server/app.ts's error handler) — split it back into a per-field
 * map, so a settings form can surface each at its field via {@link FieldError},
 * falling back to the whole string for anything unmapped. Shared by the global
 * and per-Workspace settings pages. */
export function parseFieldErrors(message: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of message.split('; ')) {
    const i = part.indexOf(': ');
    if (i === -1) continue;
    out[part.slice(0, i)] = part.slice(i + 2);
  }
  return out;
}
