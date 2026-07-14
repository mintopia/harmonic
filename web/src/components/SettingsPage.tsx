import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AppConfig } from '../types';
import { btnGhost, btnPrimary, field, labelType } from '../ui';

const panel = 'rounded-md border border-hairline bg-surface p-4';
const label = `mb-1 block ${labelType} text-muted`;

/** Server validation errors arrive as one `path: message; path: message`
 * string (src/server/app.ts's error handler) — split it back into a
 * per-field map, falling back to the whole string for anything unmapped. */
function parseFieldErrors(message: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of message.split('; ')) {
    const i = part.indexOf(': ');
    if (i === -1) continue;
    out[part.slice(0, i)] = part.slice(i + 2);
  }
  return out;
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1 text-label text-fail">{message}</p>;
}

/** On/off switch matching the header's Auto-Runner toggle (App.tsx). */
function Toggle({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 ${labelType} transition-colors duration-150 ${
        checked ? 'border-accent text-accent-text' : 'border-hairline text-muted hover:text-ink'
      }`}
    >
      {children} <span>{checked ? 'on' : 'off'}</span>
    </button>
  );
}

function TaskDefaultsSection({
  config,
  fieldErrors,
  onChange,
}: {
  config: AppConfig;
  fieldErrors: Record<string, string>;
  onChange: (defaults: AppConfig['defaults']) => void;
}) {
  const d = config.defaults;
  const set = <K extends keyof AppConfig['defaults']>(key: K, value: AppConfig['defaults'][K]) =>
    onChange({ ...d, [key]: value });

  return (
    <div className={`${panel} mb-4`}>
      <h3 className="mb-3 text-headline font-semibold">Task defaults</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="settings-harness">Harness</label>
          <select id="settings-harness" className={field} value={d.harness} onChange={(e) => set('harness', e.target.value)}>
            {Object.keys(config.harnesses).map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
          <FieldError message={fieldErrors['defaults.harness']} />
        </div>
        <div>
          <label className={label} htmlFor="settings-workdir">Working Directory</label>
          <input
            id="settings-workdir"
            className={`${field} font-data`}
            value={d.workingDir}
            onChange={(e) => set('workingDir', e.target.value)}
          />
          <FieldError message={fieldErrors['defaults.workingDir']} />
        </div>
        <div>
          <label className={label} htmlFor="settings-isolation">Isolation Mode</label>
          <select
            id="settings-isolation"
            className={field}
            value={d.isolationMode}
            onChange={(e) => set('isolationMode', e.target.value as 'direct' | 'worktree')}
          >
            <option value="direct">direct</option>
            <option value="worktree">worktree</option>
          </select>
          <FieldError message={fieldErrors['defaults.isolationMode']} />
        </div>
        <div>
          <label className={label} htmlFor="settings-priority">Priority</label>
          <select
            id="settings-priority"
            className={field}
            value={d.priority}
            onChange={(e) => set('priority', e.target.value as 'high' | 'normal' | 'low')}
          >
            <option value="high">high</option>
            <option value="normal">normal</option>
            <option value="low">low</option>
          </select>
          <FieldError message={fieldErrors['defaults.priority']} />
        </div>
      </div>
    </div>
  );
}

function AutoRunnerSection({
  config,
  fieldErrors,
  onChange,
}: {
  config: AppConfig;
  fieldErrors: Record<string, string>;
  onChange: (autoRunner: AppConfig['autoRunner']) => void;
}) {
  const a = config.autoRunner;
  return (
    <div className={`${panel} mb-4`}>
      <h3 className="mb-3 text-headline font-semibold">Auto-Runner</h3>
      <div className="flex flex-wrap items-start gap-4">
        <div>
          <Toggle checked={a.enabled} onChange={(enabled) => onChange({ ...a, enabled })}>
            Enabled
          </Toggle>
          <FieldError message={fieldErrors['autoRunner.enabled']} />
        </div>
        <div>
          <label className={label} htmlFor="settings-max-runs">Max concurrent Runs</label>
          <input
            id="settings-max-runs"
            type="number"
            min={1}
            className={`${field} w-32 font-data`}
            value={a.maxConcurrentRuns}
            onChange={(e) => onChange({ ...a, maxConcurrentRuns: Number(e.target.value) })}
          />
          <FieldError message={fieldErrors['autoRunner.maxConcurrentRuns']} />
        </div>
      </div>
    </div>
  );
}

function AgentReviewSection({
  config,
  fieldErrors,
  onChange,
}: {
  config: AppConfig;
  fieldErrors: Record<string, string>;
  onChange: (agentReview: boolean) => void;
}) {
  return (
    <div className={`${panel} mb-4`}>
      <h3 className="mb-3 text-headline font-semibold">Agent review</h3>
      <Toggle checked={config.agentReview} onChange={onChange}>
        Agents may Accept/Reject their own runs
      </Toggle>
      <FieldError message={fieldErrors['agentReview']} />
    </div>
  );
}

export function SettingsPage({ onSaved }: { onSaved: (config: AppConfig) => void }) {
  const [pristine, setPristine] = useState<AppConfig | null>(null);
  const [local, setLocal] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    api.config().then((c) => {
      setPristine(c);
      setLocal(c);
    });
  }, []);

  if (!local || !pristine) return null;

  const dirty = JSON.stringify(local) !== JSON.stringify(pristine);

  const discard = () => {
    setLocal(pristine);
    setError(null);
    setFieldErrors({});
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      const updated = await api.replaceConfig(local);
      setPristine(updated);
      setLocal(updated);
      onSaved(updated);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      setFieldErrors(parseFieldErrors(message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="text-display font-semibold tracking-tight">Settings</h2>
        {dirty && (
          <div className="ml-auto flex items-center gap-2">
            <button disabled={saving} onClick={discard} className={btnGhost}>
              Discard
            </button>
            <button disabled={saving} onClick={save} className={btnPrimary}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-fail px-4 py-2 text-fail">{error}</div>
      )}

      <TaskDefaultsSection
        config={local}
        fieldErrors={fieldErrors}
        onChange={(defaults) => setLocal({ ...local, defaults })}
      />
      <AutoRunnerSection
        config={local}
        fieldErrors={fieldErrors}
        onChange={(autoRunner) => setLocal({ ...local, autoRunner })}
      />
      <AgentReviewSection
        config={local}
        fieldErrors={fieldErrors}
        onChange={(agentReview) => setLocal({ ...local, agentReview })}
      />

      {/* Issue 8 inserts Harness cards + price overrides here, as its own
          section component, following the same { config, fieldErrors, onChange } shape. */}

      {/* Issue 9 inserts a security/password section here (below everything
          else, since it changes the operator's own credential rather than
          Harmonic's config). */}
    </div>
  );
}
