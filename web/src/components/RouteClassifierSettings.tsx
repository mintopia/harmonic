import type { ReactNode } from 'react';
import { api } from '../api';
import type { ClassifierEndpoint, Workspace } from '../types';
import { chip, field } from '../ui';
import { useAsyncResource } from '../useAsyncResource';
import { FieldError, fieldLabel } from './SettingsSection';
import { Switch } from './Switch';

type Backend = NonNullable<Workspace['classifierBackend']>;

const BACKENDS: ReadonlyArray<{ id: Backend; label: string; note: string }> = [
  { id: 'typesafe', label: 'TypeSafe decision model', note: 'Jev family, called via OpenRouter.' },
  { id: 'openai-compatible', label: 'OpenAI-compatible endpoint', note: 'Must support structured output (JSON schema).' },
  {
    id: 'harness',
    label: 'Harness',
    note: 'The Workspace default Harness and Model, run as a one-shot Session with no tool permissions, outside any worktree. The fields below follow the selected backend.',
  },
];

const EMPTY_ENDPOINT: ClassifierEndpoint = { baseUrl: '', model: '', apiKeySecret: '' };
const dataField = `${field} min-h-11 font-data text-data`;
const notice = 'flex items-start gap-2 rounded-md px-3 py-2 text-small';

function SecretStatus({ workspaceId, name }: { workspaceId: number; name: string }) {
  const status = useAsyncResource(name ? () => api.secretStatus(workspaceId, name) : null, [workspaceId, name]);
  if (!name || !status.data) return null;
  return status.data.set ? (
    <p className="mt-1.5">
      <span className={`${chip} bg-accent-tint text-accent`}>Secret set</span>
    </p>
  ) : (
    <>
      <p className="mt-1.5">
        <span className={`${chip} bg-fail-tint text-fail`}>Secret not set</span>
      </p>
      <div role="alert" className={`${notice} mt-2 bg-fail-tint text-fail`}>
        <div>
          <b>Secret <code>{name}</code> is not set.</b> The Route Classifier cannot call it, so it will abstain until the Secret is set in Settings › Security. Saving is still allowed.
        </div>
      </div>
    </>
  );
}

function Labeled({ id, label, error, children }: { id: string; label: string; error?: string; children: ReactNode }) {
  return (
    <div>
      <label className={fieldLabel} htmlFor={id}>{label}</label>
      {children}
      <FieldError message={error} />
    </div>
  );
}

/** Per-Workspace Route Classifier controls; every value left `null` inherits the built-in default. */
export function RouteClassifierSettings({
  workspace,
  optionCount,
  errors,
  onChange,
}: {
  workspace: Workspace;
  optionCount: number;
  errors: Record<string, string>;
  onChange: (workspace: Workspace) => void;
}) {
  const enabled = workspace.classifierEnabled ?? false;
  const backend = workspace.classifierBackend ?? 'harness';
  const endpoint = workspace.classifierEndpoint ?? EMPTY_ENDPOINT;
  const set = (patch: Partial<Workspace>) => onChange({ ...workspace, ...patch });
  const setEndpoint = (patch: Partial<ClassifierEndpoint>) => {
    const next = { ...endpoint, ...patch };
    set({ classifierEndpoint: next.baseUrl || next.model || next.apiKeySecret ? next : null });
  };
  const secretName = backend === 'typesafe' ? (workspace.classifierTypesafeSecret ?? '') : endpoint.apiKeySecret;
  const current = BACKENDS.find((b) => b.id === backend);

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <p className="mb-2 text-small text-muted">
          {enabled ? 'On.' : 'Off. Attempts start with the Routing Label or Workspace default; nothing is classified or charged.'}
        </p>
        <Switch checked={enabled} onChange={(v) => set({ classifierEnabled: v })} label="Route Classifier" />
      </div>
      {enabled && optionCount === 0 && (
        <div role="status" className={`${notice} mb-3 bg-raised text-muted`}>
          <div>
            <b>No Model Options.</b> The Route Classifier will abstain every time and the Workspace default applies. Add a Model Option above.
          </div>
        </div>
      )}
      <fieldset disabled={!enabled} className={`flex flex-col gap-4 ${enabled ? '' : 'opacity-55'}`}>
        <div>
          <span className={fieldLabel} id="classifier-backend-label">Backend</span>
          <div role="radiogroup" aria-labelledby="classifier-backend-label" className="inline-flex flex-wrap overflow-hidden rounded-md border border-edge">
            {BACKENDS.map((b) => (
              <button
                key={b.id}
                type="button"
                role="radio"
                aria-checked={backend === b.id}
                className={`min-h-11 px-3 text-small font-semibold ${backend === b.id ? 'bg-accent-tint text-accent' : 'bg-field text-muted hover:text-ink'}`}
                onClick={() => set({ classifierBackend: b.id })}
              >
                {b.label}
              </button>
            ))}
          </div>
          <FieldError message={errors['classifierBackend']} />
          {current && <p className="mt-1.5 text-small text-faint">{current.note}</p>}
        </div>
        {backend === 'openai-compatible' && (
          <>
            <Labeled id="classifier-endpoint-url" label="Endpoint URL" error={errors['classifierEndpoint.baseUrl'] ?? errors['classifierEndpoint']}>
              <input id="classifier-endpoint-url" className={dataField} value={endpoint.baseUrl} placeholder="https://llm.internal/v1" onChange={(e) => setEndpoint({ baseUrl: e.target.value })} />
            </Labeled>
            <Labeled id="classifier-endpoint-model" label="Endpoint model" error={errors['classifierEndpoint.model']}>
              <input id="classifier-endpoint-model" className={dataField} value={endpoint.model} onChange={(e) => setEndpoint({ model: e.target.value })} />
            </Labeled>
          </>
        )}
        {backend !== 'harness' && (
          <Labeled
            id="classifier-secret"
            label="Secret"
            error={backend === 'typesafe' ? errors['classifierTypesafeSecret'] : errors['classifierEndpoint.apiKeySecret']}
          >
            <input
              id="classifier-secret"
              className={dataField}
              value={secretName}
              placeholder="OPENROUTER_API_KEY"
              onChange={(e) =>
                backend === 'typesafe' ? set({ classifierTypesafeSecret: e.target.value || null }) : setEndpoint({ apiKeySecret: e.target.value })
              }
            />
            <SecretStatus workspaceId={workspace.id} name={secretName} />
          </Labeled>
        )}
        <Labeled id="classifier-timeout" label="Timeout (seconds)" error={errors['classifierTimeoutSeconds']}>
          <input
            id="classifier-timeout"
            type="number"
            min={1}
            className={dataField}
            value={workspace.classifierTimeoutSeconds ?? ''}
            placeholder="30"
            onChange={(e) => set({ classifierTimeoutSeconds: e.target.value === '' ? null : Number(e.target.value) })}
          />
          <p className="mt-1 text-small text-faint">Default 30. On timeout the classifier abstains.</p>
        </Labeled>
        <div>
          <span className={fieldLabel}>Output contract</span>
          <div className="rounded-md bg-sunken px-3 py-2 text-small text-muted">
            The classifier must return <code>{'{optionId, reason}'}</code>. <code>optionId</code> must be the code of one Model Option above; anything else is an invalid output and the classifier abstains.
          </div>
        </div>
      </fieldset>
    </div>
  );
}
