import { useState, type ReactNode } from 'react';
import { api, type ClassifierTestResult } from '../api';
import { buildClassifierPrompt } from '../../../src/execution/prompt-assembly.js';
import { bundledEnginePrompts } from '../../../src/domain/bundled-prompts.js';
import { SAMPLE_CLASSIFIER_INPUT } from '../prompt-preview-model';
import type { AppConfig, ClassifierEndpoint, Workspace } from '../types';
import { btnGhost, btnPrimary, chip, field, selectField } from '../ui';
import { useAsyncResource } from '../useAsyncResource';
import { DiscoveryModelPicker } from './DiscoveryModelPicker';
import { modelOptionRows } from './model-option-model';
import { FieldError, fieldLabel } from './SettingsSection';
import { providerLabel } from './TaskIdentity';
import { defaultHarnessId } from './verification-override-model';

type Backend = NonNullable<Workspace['classifierBackend']>;

const BACKENDS: ReadonlyArray<{ id: Backend; label: string; note: string }> = [
  { id: 'typesafe', label: 'TypeSafe decision model', note: 'Jev family, called via OpenRouter.' },
  { id: 'openai-compatible', label: 'OpenAI-compatible endpoint', note: 'Must support structured output (JSON schema).' },
  {
    id: 'harness',
    label: 'Harness',
    note: 'Harness: a configured Harness run as a one-shot Session, with no tool permissions, outside any worktree. The fields below follow the selected backend.',
  },
];

const EMPTY_ENDPOINT: ClassifierEndpoint = { baseUrl: '', model: '', apiKeySecret: '' };
const DEFAULT_TIMEOUT_SECONDS = 30;
const dataField = `${field} min-h-11 font-data text-data`;
const notice = 'flex items-start gap-2 rounded-md px-3 py-2.5 text-small';
const contract = 'rounded-md border border-hairline bg-sunken px-3 py-2.5 text-small text-muted';
const spinner = 'mr-2 inline-block size-3 animate-spin rounded-full border-2 border-r-transparent motion-reduce:animate-none';

function TriangleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="mt-0.5 flex-none">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 2 1.5 13.5h13z" />
        <path d="M8 6.5v3.2M8 11.7v.1" />
      </g>
    </svg>
  );
}

function SecretPicker({
  workspaceId,
  value,
  error,
  onChange,
}: {
  workspaceId: number;
  value: string;
  error?: string | undefined;
  onChange: (name: string) => void;
}) {
  const list = useAsyncResource(() => api.secrets(workspaceId), [workspaceId]);
  const status = useAsyncResource(value ? () => api.secretStatus(workspaceId, value) : null, [workspaceId, value]);
  const names = (list.data?.secrets ?? []).map((s) => s.name);
  const options = value && !names.includes(value) ? [...names, value] : names;
  const unset = value !== '' && status.data?.set === false;
  return (
    <div>
      <label className={fieldLabel} htmlFor="classifier-secret">Secret</label>
      <select
        id="classifier-secret"
        aria-invalid={unset || error !== undefined}
        className={`${selectField} w-full font-data text-data ${unset || error ? 'border-fail' : ''}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Select a Secret</option>
        {options.map((name) => (
          <option key={name} value={name}>{name}</option>
        ))}
      </select>
      <FieldError message={error} />
      {value !== '' && status.data && (
        <p className="mt-1.5">
          <span className={`${chip} ${status.data.set ? 'bg-merged-tint text-merged' : 'bg-fail-tint text-fail'}`}>
            {status.data.set ? 'Secret set' : 'Secret not set'}
          </span>
        </p>
      )}
      {unset && (
        <div role="alert" className={`${notice} mt-2 bg-fail-tint text-fail`}>
          <TriangleIcon />
          <div>
            <b>Secret <code>{value}</code> is not set.</b> The Route Classifier cannot call it, so it will abstain until the Secret is set in Settings › Security. Saving is still allowed.
          </div>
        </div>
      )}
    </div>
  );
}

function Labeled({ id, label, error, children }: { id: string; label: string; error?: string | undefined; children: ReactNode }) {
  return (
    <div>
      <label className={fieldLabel} htmlFor={id}>{label}</label>
      {children}
      <FieldError message={error} />
    </div>
  );
}

function resolvedPrompt(config: AppConfig, workspace: Workspace): string {
  const options = modelOptionRows(workspace.modelOptions, config.modelOptions)
    .filter((row) => row.enabled)
    .map(({ option }) => option);
  return buildClassifierPrompt(
    { ...SAMPLE_CLASSIFIER_INPUT, options: options.length > 0 ? options : SAMPLE_CLASSIFIER_INPUT.options },
    bundledEnginePrompts(),
  );
}

function TestResult({ result, error }: { result: ClassifierTestResult | null; error: string | null }) {
  if (error) return <p role="alert" className="text-small text-fail">{error}</p>;
  if (!result) return null;
  return (
    <div role="status" className={contract}>
      {result.outcome === 'chosen' ? (
        <>Chose <code>{result.optionId}</code>: {result.reason}</>
      ) : (
        <>Abstained: {result.reason}</>
      )}
    </div>
  );
}

/** Per-Workspace Route Classifier controls; every value left `null` inherits the built-in default. */
export function RouteClassifierSettings({
  workspace,
  config,
  optionCount,
  errors,
  saving = false,
  onSave,
  onChange,
  children,
}: {
  children?: ReactNode;
  workspace: Workspace;
  config: AppConfig;
  optionCount: number;
  errors: Record<string, string>;
  saving?: boolean;
  onSave?: () => void;
  onChange: (workspace: Workspace) => void;
}) {
  const [showPrompt, setShowPrompt] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ClassifierTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const enabled = workspace.classifierEnabled ?? false;
  const backend = workspace.classifierBackend ?? 'harness';
  const endpoint = workspace.classifierEndpoint ?? EMPTY_ENDPOINT;
  const timeout = workspace.classifierTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const harness = workspace.classifierHarness ?? defaultHarnessId(config);
  const model = workspace.classifierModel ?? config.harnesses[harness]?.defaultModel ?? '';
  const set = (patch: Partial<Workspace>) => onChange({ ...workspace, ...patch });
  const setEndpoint = (patch: Partial<ClassifierEndpoint>) => {
    const next = { ...endpoint, ...patch };
    set({ classifierEndpoint: next.baseUrl || next.model || next.apiKeySecret ? next : null });
  };
  const current = BACKENDS.find((b) => b.id === backend);
  const exampleCode = modelOptionRows(workspace.modelOptions, config.modelOptions).find((row) => row.enabled)?.option.id ?? 'opus-deep';

  const test = async () => {
    setTesting(true);
    setResult(null);
    setTestError(null);
    try {
      setResult(
        await api.testClassifier(workspace.id, {
          modelOptions: workspace.modelOptions,
          classifierBackend: workspace.classifierBackend,
          classifierTimeoutSeconds: workspace.classifierTimeoutSeconds,
          classifierTypesafeModel: workspace.classifierTypesafeModel,
          classifierTypesafeSecret: workspace.classifierTypesafeSecret,
          classifierHarness: workspace.classifierHarness,
          classifierModel: workspace.classifierModel,
          classifierEndpoint: workspace.classifierEndpoint,
        }),
      );
    } catch (e) {
      setTestError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div>
      <p className="mb-2 text-small text-muted">
        {enabled ? 'On.' : 'Off. Attempts start with the Routing Label or Workspace default; nothing is classified or charged.'}
      </p>
      {enabled && optionCount === 0 && (
        <div role="status" className={`${notice} mb-3 bg-raised text-ink`}>
          <TriangleIcon />
          <div>
            <b>No Model Options.</b> The Route Classifier will abstain every time and the Workspace default applies. Add a Model Option above, or turn Global rows back on.
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
                className={`min-h-9 border-l border-edge px-3 text-small first:border-l-0 ${backend === b.id ? 'bg-accent-tint font-semibold text-accent' : 'bg-field text-muted hover:text-ink'}`}
                onClick={() => set({ classifierBackend: b.id })}
              >
                {b.label}
              </button>
            ))}
          </div>
          <FieldError message={errors['classifierBackend']} />
          {current && <p className="mt-1.5 text-small text-faint">{current.note}</p>}
        </div>
        {backend === 'harness' && (
          <>
            <Labeled id="classifier-harness" label="Harness" error={errors['classifierHarness']}>
              <select
                id="classifier-harness"
                className={`${selectField} w-full`}
                value={harness}
                onChange={(e) => set({ classifierHarness: e.target.value, classifierModel: config.harnesses[e.target.value]?.defaultModel ?? null })}
              >
                {Object.keys(config.harnesses).map((h) => (
                  <option key={h} value={h}>{providerLabel(h)}</option>
                ))}
              </select>
            </Labeled>
            <div>
              <span className={fieldLabel}>Model</span>
              <DiscoveryModelPicker
                id="classifier-model"
                ariaLabel="Model"
                harness={harness}
                value={model}
                options={(config.harnesses[harness]?.models ?? []).map((m) => m.id)}
                onChange={(next) => set({ classifierHarness: harness, classifierModel: next || null })}
              />
              <FieldError message={errors['classifierModel']} />
            </div>
          </>
        )}
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
        {backend === 'typesafe' && (
          <SecretPicker
            workspaceId={workspace.id}
            value={workspace.classifierTypesafeSecret ?? ''}
            error={errors['classifierTypesafeSecret']}
            onChange={(name) => set({ classifierTypesafeSecret: name || null })}
          />
        )}
        {backend === 'openai-compatible' && (
          <SecretPicker
            workspaceId={workspace.id}
            value={endpoint.apiKeySecret}
            error={errors['classifierEndpoint.apiKeySecret']}
            onChange={(name) => setEndpoint({ apiKeySecret: name })}
          />
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
          <span className={fieldLabel}>Classifier instructions</span>
          <div className={`${field} flex min-h-11 items-center justify-between`}>
            <code className="font-data text-data">route-classifier</code>
            <button type="button" aria-expanded={showPrompt} className="text-small font-semibold text-accent underline underline-offset-2 hover:text-accent-hot" onClick={() => setShowPrompt(!showPrompt)}>
              {showPrompt ? 'Hide resolved prompt' : 'View resolved prompt'}
            </button>
          </div>
          <p className="mt-1 text-small text-faint">A Prompt Library entry; edit it in Settings › Prompts.</p>
          {showPrompt && (
            <pre aria-label="Resolved prompt" className={`${contract} mt-2 max-h-72 overflow-auto whitespace-pre-wrap font-data text-data`}>
              {resolvedPrompt(config, workspace)}
            </pre>
          )}
        </div>
        <div>
          <span className={fieldLabel}>Output contract</span>
          <div className={contract}>
            The classifier must return <code>{'{optionId, reason}'}</code>. <code>optionId</code> must be the code of one Model Option above (for example <code>{exampleCode}</code>); anything else is an invalid output and the classifier abstains.
          </div>
        </div>
      </fieldset>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className={`${btnPrimary} ${saving ? 'opacity-75' : ''}`} disabled={saving || onSave === undefined} onClick={onSave}>
          {saving && <span aria-hidden="true" className={`${spinner} border-on-accent`} />}
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className={`${btnGhost} ${testing ? 'opacity-75' : ''}`} disabled={testing} onClick={test}>
          {testing && <span aria-hidden="true" className={`${spinner} border-muted`} />}
          {testing ? 'Testing classifier…' : 'Test classifier'}
        </button>
      </div>
      <p className="mt-3 text-small text-faint">
        {testing || saving ? `Waiting for a reply (up to ${timeout} s)` : 'Test runs against a sample Ticket and records no Cost on any Ticket.'}
      </p>
      {testing && (
        <div className="mt-3">
          <span className={fieldLabel}>Test result</span>
          <div aria-busy="true" className={contract}>
            <span className="inline-block h-2.5 w-[120px] rounded-sm bg-raised" />
            <br />
            <br />
            <span className="inline-block h-2.5 w-[260px] rounded-sm bg-raised" />
          </div>
        </div>
      )}
      {!testing && (result || testError) && (
        <div className="mt-3">
          <span className={fieldLabel}>Test result</span>
          <TestResult result={result} error={testError} />
        </div>
      )}
      {children && <div className="mt-4 border-t border-hairline pt-4">{children}</div>}
    </div>
  );
}
