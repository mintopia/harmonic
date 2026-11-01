import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { useAsyncResource } from '../useAsyncResource';
import type { CodeRepositoryKind, JSONSchemaProperty, TrackerDetection, TrackerKindInfo, TrackerSource, VerifyResult, Workspace } from '../types';
import {
  REPOSITORY_KINDS,
  REPOSITORY_LABEL,
  RESOLVE_FAILURE_LABEL,
  applyTrackerSetting,
  applyTriageLabel,
  TRIAGE_SOURCE_LABEL,
  parseCodeRepositoryOverride,
  triageLabelSource,
  type TriageLabelSource,
} from '../tracker-settings-model';
import { btnGhost, field, selectField, tableHead } from '../ui';
import { DEFAULT_TRIAGE_LABELS, type TriageLabels } from '../../../src/tracker/triage-defaults.js';
import { FieldError, fieldLabel } from './SettingsSection';
import { Switch } from './Switch';
import type { WorkspaceRenderCtx } from './settings-schema';

const SOURCE_LABEL: Record<TrackerSource, string> = {
  configured: 'Configured',
  detected: 'Detected',
  'code-repository': 'Code Repository',
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

const detectionInFlight = new Map<number, Promise<TrackerDetection>>();

function loadDetection(workspaceId: number): Promise<TrackerDetection> {
  const pending = detectionInFlight.get(workspaceId);
  if (pending) return pending;
  const request = api.trackerDetection(workspaceId).finally(() => detectionInFlight.delete(workspaceId));
  detectionInFlight.set(workspaceId, request);
  return request;
}

function useDetection(workspaceId: number) {
  return useLoad(() => loadDetection(workspaceId), workspaceId);
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

function Outcome({ tone, dot, children }: { tone: 'done' | 'fail'; dot?: boolean; children: ReactNode }) {
  return dot ? <StatusDot tone={tone}>{children}</StatusDot> : <span className={tone === 'done' ? 'text-done' : 'text-fail'}>{children}</span>;
}

function VerifyControl({
  run,
  disabled,
  disabledHint,
  label = 'Verify',
  okPrefix = 'Verified as',
  resetKey,
  dot,
}: {
  run: () => Promise<VerifyResult>;
  disabled?: boolean;
  disabledHint?: string;
  label?: string;
  okPrefix?: string;
  resetKey?: string;
  dot?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const requestId = useRef(0);
  useEffect(() => {
    requestId.current += 1;
    setBusy(false);
    setResult(null);
  }, [resetKey]);
  useEffect(
    () => () => {
      requestId.current += 1;
    },
    [],
  );
  const verify = () => {
    const mine = ++requestId.current;
    const settle = (next: VerifyResult) => {
      if (mine !== requestId.current) return;
      setResult(next);
      setBusy(false);
    };
    setBusy(true);
    setResult(null);
    run().then(settle, (error: unknown) => settle({ ok: false, reason: errorMessage(error) }));
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <button type="button" className={btnGhost} onClick={verify} disabled={busy || disabled}>
        {busy ? 'Verifying…' : label}
      </button>
      <div role="status" aria-live="polite" className="min-w-0 text-small">
        {result?.ok === true && !disabled && (
          <Outcome tone="done" dot={dot}>
            {okPrefix} <span className="font-medium">{result.identity}</span>
          </Outcome>
        )}
        {result?.ok === false && !disabled && <Outcome tone="fail" dot={dot}>{result.reason}</Outcome>}
        {disabled && disabledHint && <span className="text-muted">{disabledHint}</span>}
        {dot && !disabled && !busy && !result && <StatusDot tone="muted">Not checked yet</StatusDot>}
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
  const friendly = RESOLVE_FAILURE_LABEL[resolved.code];
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

  const cancelEdit = () => {
    setEditing(false);
    setValue('');
    setError(null);
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
          <button
            type="button"
            className={btnGhost}
            disabled={busy}
            aria-label={`${isSet ? 'Replace' : 'Set'} ${name}`}
            onClick={() => setEditing(true)}
          >
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
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !busy) cancelEdit();
            }}
            autoFocus
          />
          <button type="submit" className={btnGhost} disabled={busy || !value}>
            Save
          </button>
          <button
            type="button"
            className={btnGhost}
            disabled={busy}
            onClick={cancelEdit}
          >
            Cancel
          </button>
        </form>
      )}
      <FieldError message={error ?? undefined} />
    </div>
  );
}

function humanizeKey(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
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
  const label = property.title ?? humanizeKey(name);
  const types = Array.isArray(property.type) ? property.type : property.type ? [property.type] : [];
  const description = property.description ? <p className="mt-1 text-small text-muted">{property.description}</p> : null;
  const cleartext = name === 'baseUrl' && typeof value === 'string' && /^http:\/\//i.test(value.trim());
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
      {cleartext && (
        <p role="alert" className="mt-1 text-small text-running">
          This address is not HTTPS, so your token and requests travel unencrypted. Use it only on a network you trust.
        </p>
      )}
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
  const setSetting = (key: string, next: unknown) =>
    ctx.setWorkspace({ ...workspace, configuredTracker: applyTrackerSetting(kind.id, configured?.settings, key, next) });
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

function TrackerChoice({ id, checked, onSelect, title, note }: { id: string; checked: boolean; onSelect: () => void; title: string; note: string }) {
  return (
    <label
      htmlFor={id}
      className={`flex min-w-48 flex-1 cursor-pointer items-start gap-2.5 rounded-md ${
        checked ? 'border-2 border-accent bg-sunken p-[11px]' : 'border border-edge p-3'
      }`}
    >
      <input
        id={id}
        type="radio"
        name="workspace-tracker-kind"
        className="mt-1 accent-accent"
        checked={checked}
        onChange={onSelect}
      />
      <span className="flex flex-col">
        <span className="font-bold text-ink">{title}</span>
        <span className="text-small text-muted">{note}</span>
      </span>
    </label>
  );
}

function StatusDot({ tone, children }: { tone: 'done' | 'fail' | 'muted'; children: ReactNode }) {
  const color = tone === 'done' ? 'text-done' : tone === 'fail' ? 'text-fail' : 'text-muted';
  const dot = tone === 'done' ? 'bg-done-dot' : tone === 'fail' ? 'bg-fail-dot' : 'bg-faint';
  return (
    <div className={`flex items-center gap-2 text-small ${color}`}>
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${dot}`} />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function SubHead({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-small text-muted">{children}</p>;
}

export function IssueTrackerSection({ ctx }: { ctx: WorkspaceRenderCtx }) {
  const { workspace, pristineWorkspace, errors } = ctx;
  const kinds = useLoad(() => api.trackerKinds().then((r) => r.kinds), 'kinds');
  const detection = useDetection(workspace.id);
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

      <div className="flex flex-col gap-4">
        <fieldset className="m-0 flex flex-wrap gap-2.5 border-0 p-0" disabled={kinds.state.status !== 'ready'}>
          <legend className={`${fieldLabel} mb-2.5`}>Tracker</legend>
          <TrackerChoice
            id="workspace-tracker-kind-inherit"
            checked={!configured}
            onSelect={() => selectKind('')}
            title="Inherit (automatic)"
            note="Repo doc, then the Code Repository"
          />
          {configured && !kind && (
            <TrackerChoice
              id={`workspace-tracker-kind-${configured.kind}`}
              checked
              onSelect={() => selectKind(configured.kind)}
              title={configured.kind}
              note="Not a registered kind"
            />
          )}
          {kindList.map((k) => (
            <TrackerChoice
              key={k.id}
              id={`workspace-tracker-kind-${k.id}`}
              checked={configured?.kind === k.id}
              onSelect={() => selectKind(k.id)}
              title={k.label}
              note={k.secretNames.length > 0 ? `Secret ${k.secretNames.join(', ')}` : 'No Secret needed'}
            />
          ))}
        </fieldset>
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

const FORGEJO_TOKEN_SECRET = 'FORGEJO_TOKEN';

export function CodeRepositorySection({ ctx }: { ctx: WorkspaceRenderCtx }) {
  const { workspace, pristineWorkspace, errors } = ctx;
  const detection = useDetection(workspace.id);
  const detected = detection.state.status === 'ready' ? detection.state.value.detectedCodeRepository : null;
  const [secretVersion, setSecretVersion] = useState(0);
  const needsForgejoToken = (pristineWorkspace.codeRepository ?? detected) === 'forgejo' && pristineWorkspace.configuredTracker?.kind !== 'forgejo';
  const effective = pristineWorkspace.codeRepository ?? detected;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        {detection.state.status === 'loading' && <p className="text-small text-muted">Detecting…</p>}
        {detection.state.status === 'error' && <LoadFailure message={detection.state.message} onRetry={detection.reload} />}
        {detection.state.status === 'ready' && (
          <>
            <span className={detected ? 'font-bold text-ink' : 'text-muted'}>
              {detected ? REPOSITORY_LABEL[detected] : 'None detected from the origin remote'}
            </span>
            {detected && <span className="rounded-full bg-done-tint px-2 py-0.5 text-micro font-bold text-done">Detected</span>}
          </>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={fieldLabel} htmlFor="workspace-code-repository">Forge</label>
          <select
            id="workspace-code-repository"
            className={`${selectField} w-full`}
            value={workspace.codeRepository ?? ''}
            onChange={(e) =>
              ctx.setWorkspace({ ...workspace, codeRepository: parseCodeRepositoryOverride(e.target.value) })
            }
          >
            <option value="">Detected from origin</option>
            {REPOSITORY_KINDS.map((k) => (
              <option key={k} value={k}>
                {REPOSITORY_LABEL[k]}
              </option>
            ))}
          </select>
          <FieldError message={errors['codeRepository']} />
        </div>
        <div>
          <label className={fieldLabel} htmlFor="workspace-code-token">Token</label>
          <select id="workspace-code-token" className={`${selectField} w-full`} value="source" disabled>
            <option value="source">{tokenSource(effective)}</option>
          </select>
        </div>
      </div>
      {needsForgejoToken && (
        <div className="flex flex-col gap-3">
          <SecretField key={`${workspace.id}:${FORGEJO_TOKEN_SECRET}`} workspaceId={workspace.id} name={FORGEJO_TOKEN_SECRET} onChange={() => setSecretVersion((v) => v + 1)} />
          <SubHead>The Forgejo API token used to open and merge pull requests. Write-only; applies immediately.</SubHead>
        </div>
      )}
      <VerifyControl
        run={() => api.verifyRepository(workspace.id)}
        disabled={ctx.dirty}
        disabledHint="Save changes to verify the repository."
        label="Verify repository"
        okPrefix="Reachable on"
        resetKey={`${secretVersion}:${String(pristineWorkspace.codeRepository)}`}
        dot
      />
    </div>
  );
}

function tokenSource(kind: CodeRepositoryKind | null): string {
  if (kind === 'forgejo') return `Secret · ${FORGEJO_TOKEN_SECRET}`;
  if (kind === 'github') return 'Ambient · gh credentials';
  if (kind === 'gitlab') return 'Ambient · glab credentials';
  return kind === 'git' ? 'None · plain git' : 'Resolved once a forge is detected';
}

const TRIAGE_ROLES: { key: keyof TriageLabels; label: string }[] = [
  { key: 'readyForAgent', label: 'Pick up for an agent' },
  { key: 'readyForHuman', label: 'Needs a human' },
  { key: 'epic', label: 'Epic' },
  { key: 'wayfinderMap', label: 'Wayfinder map' },
];

const SOURCE_CHIP: Record<TriageLabelSource, string> = {
  configured: 'bg-ready-tint text-ready',
  'repo-doc': 'bg-accent-tint text-accent',
  default: 'bg-blocked-tint text-blocked',
};

export function TriageLabelsSection({ ctx }: { ctx: WorkspaceRenderCtx }) {
  const { workspace, errors } = ctx;
  const detection = useDetection(workspace.id);
  const repoDoc = detection.state.status === 'ready' ? detection.state.value.repoDocTriageLabels : null;
  const labels = workspace.triageLabels ?? {};
  const setLabel = (role: (typeof TRIAGE_ROLES)[number]['key'], raw: string) =>
    ctx.setWorkspace({ ...workspace, triageLabels: applyTriageLabel(workspace.triageLabels, role, raw) });
  return (
    <div className="flex flex-col gap-3">
      <table className="w-full border-collapse text-small">
        <thead>
          <tr className={`${tableHead} text-left`}>
            <th className="border-b border-hairline p-2 font-semibold">Role</th>
            <th className="border-b border-hairline p-2 font-semibold">Label</th>
            <th className="border-b border-hairline p-2 font-semibold">Source</th>
          </tr>
        </thead>
        <tbody>
          {TRIAGE_ROLES.map(({ key, label }) => {
            const source = triageLabelSource(key, workspace.triageLabels, repoDoc);
            return (
              <tr key={key}>
                <td className="border-b border-hairline p-2.5 align-middle">
                  <label htmlFor={`workspace-triage-${key}`}>{label}</label>
                </td>
                <td className="border-b border-hairline p-2.5 align-middle">
                  <input
                    id={`workspace-triage-${key}`}
                    className={`${field} w-60 max-w-full font-data`}
                    placeholder={repoDoc?.[key] ?? DEFAULT_TRIAGE_LABELS[key]}
                    value={labels[key] ?? ''}
                    onChange={(e) => setLabel(key, e.target.value)}
                  />
                </td>
                <td className="border-b border-hairline p-2.5 align-middle">
                  <span className={`rounded-full px-2 py-0.5 text-micro font-bold ${SOURCE_CHIP[source]}`}>{TRIAGE_SOURCE_LABEL[source]}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <FieldError message={errors['triageLabels']} />
      <p className="text-small text-muted">
        Labels that pick a workflow or agent live in{' '}
        <button type="button" className="font-semibold text-accent hover:underline" onClick={() => ctx.onTab?.('execution')}>
          Running Tickets
        </button>
        .
      </p>
    </div>
  );
}
