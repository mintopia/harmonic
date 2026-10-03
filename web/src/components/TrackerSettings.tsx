import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { useAsyncResource } from '../useAsyncResource';
import type {
  CodeRepositoryKind,
  JSONSchemaProperty,
  TrackerDetection,
  TrackerKindInfo,
  TrackerSource,
  VerifyResult,
  Workspace,
} from '../types';
import { btnGhost, field, selectField } from '../ui';
import { DEFAULT_TRIAGE_LABELS } from '../../../src/tracker/triage-labels.js';
import { FieldError, fieldLabel } from './SettingsSection';
import { Switch } from './Switch';
import type { WorkspaceRenderCtx } from './settings-schema';

const SOURCE_LABEL: Record<TrackerSource, string> = {
  configured: 'Configured',
  detected: 'Detected',
  'code-repository': 'Code Repository',
};

const REPOSITORY_LABEL: Record<CodeRepositoryKind, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  forgejo: 'Forgejo',
};

const RESOLVE_FAILURE_LABEL: Record<string, string> = {
  'no-declaration': 'No tracker declared',
  unsupported: 'Unsupported tracker',
  misconfigured: 'Tracker misconfigured',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Loadable<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T };

function useLoad<T>(load: () => Promise<T>, key: unknown): { state: Loadable<T>; reload: () => void } {
  const { data, error, loading, reload } = useAsyncResource(load, [key]);
  const state: Loadable<T> =
    data !== null ? { status: 'ready', value: data } : error !== null && !loading ? { status: 'error', message: error } : { status: 'loading' };
  return { state, reload };
}

function LoadFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <p role="alert" className="text-small text-fail">
      {message}{' '}
      <button type="button" className="font-medium underline" onClick={onRetry}>
        Retry
      </button>
    </p>
  );
}

function VerifyControl({
  run,
  disabled,
  disabledHint,
  label = 'Verify',
  okPrefix = 'Verified as',
  resetKey,
}: {
  run: () => Promise<VerifyResult>;
  disabled?: boolean;
  disabledHint?: string;
  label?: string;
  okPrefix?: string;
  resetKey?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  useEffect(() => setResult(null), [resetKey]);
  const verify = () => {
    setBusy(true);
    setResult(null);
    run().then(
      (r) => {
        setResult(r);
        setBusy(false);
      },
      (error: unknown) => {
        setResult({ ok: false, reason: errorMessage(error) });
        setBusy(false);
      },
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <button type="button" className={btnGhost} onClick={verify} disabled={busy || disabled}>
        {busy ? 'Verifying…' : label}
      </button>
      <div role="status" aria-live="polite" className="min-w-0 text-small">
        {result?.ok === true && (
          <span className="text-done">
            {okPrefix} <span className="font-medium">{result.identity}</span>
          </span>
        )}
        {result?.ok === false && <span className="text-fail">{result.reason}</span>}
        {!result && disabled && disabledHint && <span className="text-muted">{disabledHint}</span>}
      </div>
    </div>
  );
}

function ResolvedTrackerLine({ workspace }: { workspace: Workspace }) {
  const resolved = workspace.resolvedTracker;
  if (!resolved) {
    return (
      <p className="text-small text-muted">
        {workspace.trackerEnabled ? 'Resolving…' : 'Enable mirroring to resolve the tracker.'}
      </p>
    );
  }
  if (resolved.ok) {
    return (
      <p className="text-ink">
        <span className="text-muted">Resolved:</span> <span className="font-medium">{resolved.label}</span>{' '}
        <span className="text-muted">via {SOURCE_LABEL[resolved.source]}</span>
      </p>
    );
  }
  const friendly = (resolved.code && RESOLVE_FAILURE_LABEL[resolved.code]) ?? 'Cannot resolve tracker';
  return (
    <p className="text-fail" title={resolved.reason ?? undefined}>
      <span className="text-muted">Resolved:</span> {friendly}
    </p>
  );
}

export function SecretField({ workspaceId, name, onChange }: { workspaceId: number; name: string; onChange?: () => void }) {
  const { state, reload } = useLoad(() => api.secretStatus(workspaceId, name), `${workspaceId}:${name}`);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = `workspace-secret-${name}`;

  const act = (op: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    op().then(
      () => {
        setBusy(false);
        after?.();
        onChange?.();
        reload();
      },
      (e: unknown) => {
        setBusy(false);
        setError(errorMessage(e));
      },
    );
  };

  const isSet = state.status === 'ready' && state.value.set;
  return (
    <div>
      <span className={fieldLabel}>
        Secret <span className="font-data normal-case">{name}</span>
      </span>
      {state.status === 'loading' && <p className="text-small text-muted">Checking…</p>}
      {state.status === 'error' && <LoadFailure message={state.message} onRetry={reload} />}
      {state.status === 'ready' && !editing && (
        <div className="flex flex-wrap items-center gap-x-3">
          <span className={`font-medium ${isSet ? 'text-done' : 'text-muted'}`}>{isSet ? 'Set' : 'Not set'}</span>
          <button type="button" className={btnGhost} disabled={busy} onClick={() => setEditing(true)}>
            {isSet ? 'Replace' : 'Set'}
          </button>
          {isSet && (
            <button
              type="button"
              className={btnGhost}
              disabled={busy}
              aria-label={`Clear ${name}`}
              onClick={() => act(() => api.clearSecret(workspaceId, name))}
            >
              Clear
            </button>
          )}
        </div>
      )}
      {state.status === 'ready' && editing && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!value) return;
            act(
              () => api.setSecret(workspaceId, name, value),
              () => {
                setEditing(false);
                setValue('');
              },
            );
          }}
        >
          <input
            id={inputId}
            type="password"
            autoComplete="new-password"
            aria-label={`New value for ${name}`}
            className={`${field} w-64 max-w-full`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
          <button type="submit" className={btnGhost} disabled={busy || !value}>
            Save
          </button>
          <button
            type="button"
            className={btnGhost}
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setValue('');
              setError(null);
            }}
          >
            Cancel
          </button>
        </form>
      )}
      <FieldError message={error ?? undefined} />
    </div>
  );
}

function SchemaField({
  id,
  name,
  property,
  required,
  value,
  onChange,
}: {
  id: string;
  name: string;
  property: JSONSchemaProperty;
  required: boolean;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const label = property.title ?? name;
  const types = Array.isArray(property.type) ? property.type : property.type ? [property.type] : [];
  const description = property.description ? <p className="mt-1 text-small text-muted">{property.description}</p> : null;
  const labelNode = (
    <label className={fieldLabel} htmlFor={id}>
      {label}
      {required && <span className="text-muted normal-case"> (required)</span>}
    </label>
  );

  if (Array.isArray(property.enum)) {
    const options = property.enum.map(String);
    return (
      <div>
        {labelNode}
        <select
          id={id}
          className={`${selectField} w-full`}
          value={value === undefined ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        >
          {!required && <option value="">{property.default !== undefined ? `Default (${String(property.default)})` : 'Not set'}</option>}
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        {description}
      </div>
    );
  }
  if (types.includes('boolean')) {
    return (
      <div>
        <span className={fieldLabel}>{label}</span>
        <div className="pt-1">
          <Switch checked={value === true || (value === undefined && property.default === true)} onChange={onChange} label={label} />
        </div>
        {description}
      </div>
    );
  }
  const numeric = types.includes('number') || types.includes('integer');
  return (
    <div>
      {labelNode}
      <input
        id={id}
        type={numeric ? 'number' : 'text'}
        min={numeric ? property.minimum : undefined}
        className={`${field} ${numeric ? 'tabular-nums' : ''}`}
        placeholder={property.default !== undefined ? String(property.default) : undefined}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw === '' ? undefined : numeric ? Number(raw) : raw);
        }}
      />
      {description}
    </div>
  );
}

function KindSettings({ kind, ctx }: { kind: TrackerKindInfo; ctx: WorkspaceRenderCtx }) {
  const { workspace } = ctx;
  const configured = workspace.configuredTracker;
  const settings = configured?.settings ?? {};
  const properties = Object.entries(kind.settingsSchema.properties ?? {});
  if (properties.length === 0) return null;
  const setSetting = (key: string, next: unknown) => {
    const merged = { ...settings };
    if (next === undefined) delete merged[key];
    else merged[key] = next;
    ctx.setWorkspace({
      ...workspace,
      configuredTracker: { kind: kind.id, ...(Object.keys(merged).length > 0 ? { settings: merged } : {}) },
    });
  };
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {properties.map(([key, property]) => (
        <SchemaField
          key={key}
          id={`workspace-tracker-setting-${key}`}
          name={key}
          property={property}
          required={kind.settingsSchema.required?.includes(key) ?? false}
          value={settings[key]}
          onChange={(next) => setSetting(key, next)}
        />
      ))}
    </div>
  );
}

function SubHead({ children }: { children: ReactNode }) {
  return <p className="text-small text-muted">{children}</p>;
}

export function IssueTrackerSection({ ctx }: { ctx: WorkspaceRenderCtx }) {
  const { workspace, pristineWorkspace, errors } = ctx;
  const kinds = useLoad(() => api.trackerKinds().then((r) => r.kinds), 'kinds');
  const detection = useLoad(() => api.trackerDetection(workspace.id), workspace.id);
  const [secretVersion, setSecretVersion] = useState(0);
  const configured = workspace.configuredTracker;
  const kindList = kinds.state.status === 'ready' ? kinds.state.value : [];
  const kind = configured ? kindList.find((k) => k.id === configured.kind) : undefined;
  const detected = detection.state.status === 'ready' ? detection.state.value.detectedTracker : null;

  const selectKind = (id: string) => {
    if (id === '') ctx.setWorkspace({ ...workspace, configuredTracker: null });
    else if (configured?.kind !== id) ctx.setWorkspace({ ...workspace, configuredTracker: { kind: id } });
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
        <div>
          <span className={fieldLabel}>Enabled</span>
          <div className="pt-1">
            <Switch
              checked={workspace.trackerEnabled}
              onChange={(trackerEnabled) => ctx.setWorkspace({ ...workspace, trackerEnabled })}
            >
              Mirror tracker issues onto the board
            </Switch>
          </div>
        </div>
        <div>
          <label className={fieldLabel} htmlFor="workspace-poll-interval">Poll interval (seconds)</label>
          <input
            id="workspace-poll-interval"
            type="number"
            min={5}
            className={`${field} w-28 tabular-nums`}
            value={workspace.trackerPollIntervalSeconds}
            onChange={(e) => ctx.setWorkspace({ ...workspace, trackerPollIntervalSeconds: Number(e.target.value) })}
          />
          <FieldError message={errors['trackerPollIntervalSeconds']} />
        </div>
      </div>

      <div className="flex flex-col gap-4 sm:max-w-xl">
        <div>
          <label className={fieldLabel} htmlFor="workspace-tracker-kind">Configured Tracker</label>
          <select
            id="workspace-tracker-kind"
            className={`${selectField} w-full`}
            value={configured?.kind ?? ''}
            disabled={kinds.state.status !== 'ready'}
            onChange={(e) => selectKind(e.target.value)}
          >
            <option value="">Inherit (automatic)</option>
            {configured && !kind && <option value={configured.kind}>{configured.kind}</option>}
            {kindList.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
          {kinds.state.status === 'loading' && <SubHead>Loading tracker kinds…</SubHead>}
          {kinds.state.status === 'error' && <LoadFailure message={kinds.state.message} onRetry={kinds.reload} />}
          {!configured && (
            <SubHead>
              {detected
                ? `Inherited: the repo declares ${detected.name}${detected.kind ? '' : ' (not a kind Harmonic supports)'}.`
                : 'Inherited: uses the repo’s docs/agents/issue-tracker.md, then the Code Repository.'}
            </SubHead>
          )}
          <FieldError message={errors['configuredTracker']} />
        </div>

        {kind && <KindSettings kind={kind} ctx={ctx} />}

        {kind && kind.secretNames.length > 0 && (
          <div className="flex flex-col gap-3">
            {kind.secretNames.map((name) => (
              <SecretField key={`${workspace.id}:${name}`} workspaceId={workspace.id} name={name} onChange={() => setSecretVersion((v) => v + 1)} />
            ))}
            <SubHead>Secrets are write-only and apply immediately, without the save bar.</SubHead>
          </div>
        )}

        <VerifyControl
          run={() => api.verifyTracker(workspace.id)}
          disabled={ctx.dirty}
          disabledHint="Save changes to verify the tracker."
          label="Verify tracker"
          resetKey={`${secretVersion}:${JSON.stringify(pristineWorkspace.configuredTracker)}`}
        />

        <ResolvedTrackerLine workspace={pristineWorkspace} />
      </div>
    </div>
  );
}

const REPOSITORY_KINDS: CodeRepositoryKind[] = ['github', 'gitlab', 'forgejo'];

export function CodeRepositorySection({ ctx }: { ctx: WorkspaceRenderCtx }) {
  const { workspace, pristineWorkspace, errors } = ctx;
  const detection = useLoad<TrackerDetection>(() => api.trackerDetection(workspace.id), workspace.id);
  const detected = detection.state.status === 'ready' ? detection.state.value.detectedCodeRepository : null;
  return (
    <div className="flex flex-col gap-4 sm:max-w-xl">
      <div>
        <span className={fieldLabel}>Detected</span>
        {detection.state.status === 'loading' && <p className="text-small text-muted">Detecting…</p>}
        {detection.state.status === 'error' && <LoadFailure message={detection.state.message} onRetry={detection.reload} />}
        {detection.state.status === 'ready' && (
          <p className={detected ? 'font-medium text-ink' : 'text-muted'}>
            {detected ? REPOSITORY_LABEL[detected] : 'None detected from the origin remote'}
          </p>
        )}
      </div>
      <div>
        <label className={fieldLabel} htmlFor="workspace-code-repository">Override</label>
        <select
          id="workspace-code-repository"
          className={`${selectField} w-full`}
          value={workspace.codeRepository ?? ''}
          onChange={(e) =>
            ctx.setWorkspace({ ...workspace, codeRepository: (e.target.value || null) as CodeRepositoryKind | null })
          }
        >
          <option value="">Automatic</option>
          {REPOSITORY_KINDS.map((k) => (
            <option key={k} value={k}>
              {REPOSITORY_LABEL[k]}
            </option>
          ))}
        </select>
        <FieldError message={errors['codeRepository']} />
      </div>
      <VerifyControl
        run={() => api.verifyRepository(workspace.id)}
        disabled={ctx.dirty}
        disabledHint="Save changes to verify the repository."
        label="Verify repository"
        okPrefix="Reachable on"
        resetKey={String(pristineWorkspace.codeRepository)}
      />
    </div>
  );
}

const TRIAGE_ROLES: { key: keyof typeof DEFAULT_TRIAGE_LABELS; label: string }[] = [
  { key: 'readyForAgent', label: 'Ready for agent' },
  { key: 'readyForHuman', label: 'Ready for human' },
  { key: 'epic', label: 'Epic' },
  { key: 'wayfinderMap', label: 'Wayfinder map' },
];

export function TriageLabelsSection({ ctx }: { ctx: WorkspaceRenderCtx }) {
  const { workspace, errors } = ctx;
  const labels = workspace.triageLabels ?? {};
  const setLabel = (key: string, raw: string) => {
    const next = { ...labels, [key]: raw };
    for (const k of Object.keys(next) as (keyof typeof next)[]) if (!next[k]) delete next[k];
    ctx.setWorkspace({ ...workspace, triageLabels: Object.keys(next).length > 0 ? next : null });
  };
  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-2">
        {TRIAGE_ROLES.map(({ key, label }) => (
          <div key={key}>
            <label className={fieldLabel} htmlFor={`workspace-triage-${key}`}>{label}</label>
            <input
              id={`workspace-triage-${key}`}
              className={`${field} font-data`}
              placeholder={DEFAULT_TRIAGE_LABELS[key]}
              value={labels[key] ?? ''}
              onChange={(e) => setLabel(key, e.target.value)}
            />
          </div>
        ))}
      </div>
      <p className="mt-2 text-small text-muted">Leave a label empty to inherit it.</p>
      <FieldError message={errors['triageLabels']} />
    </div>
  );
}
