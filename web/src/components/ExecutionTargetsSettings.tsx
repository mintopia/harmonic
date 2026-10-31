import { useState, type ReactNode } from 'react';
import { api } from '../api';
import { errorText } from '../error-text';
import { toastError } from '../toast';
import { useAsyncResource } from '../useAsyncResource';
import type { ConnectionTestResult, DeletionImpact, ExecutionTarget } from '../types';
import {
  NEW_TARGET_DRAFT,
  canTestConnection,
  connectionTestRequest,
  deleteCopy,
  draftBody,
  draftErrors,
  draftFromTarget,
  draftPatch,
  resultPanel,
  rowView,
  testingMessage,
  type DraftField,
  type TargetDraft,
} from '../execution-targets-model';
import { btnDestructive, btnGhost, btnPrimary, btnQuiet, btnQuietDestructive, card, field, sectionTitle, statePillShape } from '../ui';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { LoadError } from './LoadError';
import { Switch } from './Switch';
import { FieldError, fieldLabel } from './SettingsSection';
import { Parts } from './execution-target-parts';
import { RepositoryProxyKey } from './RepositoryProxyKey';

const smallBtn =
  'inline-flex min-h-8 items-center rounded-md border border-edge bg-surface px-2.5 py-0.5 text-small font-medium text-ink transition-colors hover:border-faint disabled:opacity-50';
const smallBtnFail = `${smallBtn} !text-fail`;
const help = 'mt-1 text-small text-faint';
const codeInline = 'rounded-sm bg-sunken px-1.5 font-data text-small';

function StatusPill({ label }: { label: string }) {
  const tone = label === 'disabled' ? 'bg-raised text-muted' : 'bg-merged-tint text-merged';
  return (
    <span className={`${statePillShape} gap-1.5 whitespace-nowrap ${tone}`}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

const ROW_GRID = 'grid grid-cols-1 items-center gap-3 px-3.5 py-2.5 md:grid-cols-[190px_130px_120px_minmax(0,1fr)_190px]';

export function ExecutionTargetsPanel({ hostCeiling }: { hostCeiling: number }) {
  const targets = useAsyncResource(() => api.executionTargets(), []);
  const [editing, setEditing] = useState<ExecutionTarget | 'new' | null>(null);
  const [deleting, setDeleting] = useState<{ target: ExecutionTarget; impact: DeletionImpact | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (targets.error && !targets.data) return <LoadError message={`execution targets: ${targets.error}`} onRetry={targets.reload} />;
  if (!targets.data) return <p role="status" className="p-4 text-muted">Loading Execution Targets…</p>;

  const list = targets.data.targets;
  const editorTarget = editing && editing !== 'new' ? (list.find((t) => t.name === editing.name) ?? editing) : null;

  const toggle = (target: ExecutionTarget) => {
    setBusy(target.name);
    api
      .updateExecutionTarget(target.name, { enabled: !target.enabled })
      .then(targets.reload, toastError)
      .finally(() => setBusy(null));
  };

  const askDelete = (target: ExecutionTarget) => {
    setBusy(target.name);
    api
      .executionTargetDeletionImpact(target.name)
      .then((impact) => setDeleting({ target, impact }), (e) => {
        toastError(e);
        setDeleting({ target, impact: null });
      })
      .finally(() => setBusy(null));
  };

  const confirmDelete = () => {
    if (!deleting) return;
    const { target } = deleting;
    setDeleting(null);
    api.deleteExecutionTarget(target.name).then(() => {
      if (editing && editing !== 'new' && editing.name === target.name) setEditing(null);
      targets.reload();
    }, toastError);
  };

  return (
    <div className="flex flex-col gap-3">
      <section className={`${card} p-5`}>
        <h2 className={sectionTitle}>Execution Targets</h2>
        <p className="mb-4 mt-0.5 text-muted">
          Where a Task Execution Workflow runs. A workflow or a Step picks one with <code className={codeInline}>runs_on</code>. Every Kubernetes target
          needs a Code Repository on the Workspace, because the remote is the base branch&apos;s source of truth.
        </p>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-label font-semibold uppercase text-muted">Targets</span>
          <button type="button" className="min-h-8 text-small font-semibold text-accent hover:text-accent-hot" onClick={() => setEditing('new')}>
            + Add Kubernetes target
          </button>
        </div>
        <div role="table" aria-label="Execution Targets" className="flex flex-col gap-1.5 rounded-lg border border-hairline bg-sunken p-1.5">
          <div role="row" className={`hidden text-label font-semibold uppercase text-faint md:grid md:grid-cols-[190px_130px_120px_minmax(0,1fr)_190px] md:gap-3 md:px-3.5`}>
            <span role="columnheader">Target</span>
            <span role="columnheader">Namespace</span>
            <span role="columnheader">Concurrency</span>
            <span role="columnheader">Default image</span>
            <span role="columnheader" className="sr-only">Actions</span>
          </div>
          {list.map((target) => {
            const view = rowView(target);
            const dim = target.enabled || target.builtIn ? '' : 'opacity-70';
            return (
              <div key={target.name} role="row" className={`${ROW_GRID} rounded-lg bg-surface shadow-card`}>
                <div role="cell" className={`flex items-center gap-2.5 ${dim}`}>
                  <span className="whitespace-nowrap font-data font-semibold">{view.name}</span>
                  <StatusPill label={view.statusLabel} />
                </div>
                <div role="cell" className={dim}>{target.builtIn ? 'the Harmonic host' : <code className={codeInline}>{target.namespace}</code>}</div>
                <div role="cell" className="flex flex-col gap-1">
                  {target.builtIn ? (
                    <span className="text-[13px]">Host Ceiling <b>{hostCeiling}</b></span>
                  ) : (
                    <>
                      <span className="text-[13px]"><b>{target.running}</b>/{target.concurrencyLimit} running</span>
                      <span role="img" aria-label={view.runningLabel ?? ''} className="h-1.5 w-full max-w-28 overflow-hidden rounded-full bg-raised">
                        <i className={`block h-full ${view.full ? 'bg-ready' : 'bg-running'}`} style={{ width: `${view.runningPercent}%` }} />
                      </span>
                    </>
                  )}
                </div>
                <div role="cell" className={dim}>
                  {target.builtIn ? (
                    <span className="text-small text-muted">Not editable. Bounded by the Host Ceiling.</span>
                  ) : (
                    <code className="break-words font-data text-[11.5px] leading-snug">{target.defaultImage}</code>
                  )}
                </div>
                <div role="cell" className="flex items-center justify-end gap-1.5">
                  {!target.builtIn && (
                    <>
                      <button type="button" className={smallBtn} aria-label={`Edit ${target.name}`} onClick={() => setEditing(target)}>Edit</button>
                      <button type="button" className={smallBtn} aria-label={`${view.toggleLabel} ${target.name}`} disabled={busy === target.name} onClick={() => toggle(target)}>
                        {view.toggleLabel}
                      </button>
                      <button type="button" className={smallBtnFail} aria-label={`Delete ${target.name}`} disabled={busy === target.name} onClick={() => askDelete(target)}>Delete</button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-small text-faint">
          Disabling a target does not stop work already running there. Tickets waiting for it stay <code className={codeInline}>ready</code>.
        </p>
      </section>

      {editing && (
        <TargetEditor
          key={editorTarget?.name ?? 'new'}
          target={editorTarget}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            targets.reload();
          }}
          onChanged={targets.reload}
          onDelete={(target) => askDelete(target)}
        />
      )}

      {deleting && (
        <DeleteTargetDialog name={deleting.target.name} impact={deleting.impact} onConfirm={confirmDelete} onCancel={() => setDeleting(null)} />
      )}
    </div>
  );
}

function DeleteTargetDialog({ name, impact, onConfirm, onCancel }: { name: string; impact: DeletionImpact | null; onConfirm: () => void; onCancel: () => void }) {
  const copy = deleteCopy(name, impact);
  return (
    <Modal label={`Delete Execution Target ${name}`} onClose={onCancel} className="max-w-lg">
      <div className="p-5">
        <h2 className="mb-2 pr-6 text-[15px] font-semibold text-ink">
          {copy.title} <code className="font-data text-small">{name}</code>?
        </h2>
        {copy.banner && (
          <div role="alert" className="mb-3 rounded-md bg-fail-tint px-3 py-2.5 text-[13px] text-ink">
            <b className="font-semibold text-fail">{copy.banner.headline}</b> {copy.banner.detail}
          </div>
        )}
        <p className="text-muted">
          Running pods are stopped and deleted with their per-pod Secret. Workflows with <code className={codeInline}>runs_on: {name}</code> fail at save
          until you change them. Secrets stored for this target are removed.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={btnQuiet} onClick={onCancel}>Cancel</button>
          <button type="button" className={btnDestructive} onClick={onConfirm}>{copy.confirmLabel}</button>
        </div>
      </div>
    </Modal>
  );
}

type TestState = { status: 'idle' } | { status: 'testing'; namespace: string } | { status: 'done'; result: ConnectionTestResult } | { status: 'error'; message: string };

function TargetEditor({
  target,
  onCancel,
  onSaved,
  onChanged,
  onDelete,
}: {
  target: ExecutionTarget | null;
  onCancel: () => void;
  onSaved: () => void;
  onChanged: () => void;
  onDelete: (target: ExecutionTarget) => void;
}) {
  const [draft, setDraft] = useState<TargetDraft>(target ? draftFromTarget(target) : NEW_TARGET_DRAFT);
  const [replacing, setReplacing] = useState(target?.kubeconfig?.set !== true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [test, setTest] = useState<TestState>({ status: 'idle' });
  const errors = submitted ? draftErrors(draft) : {};
  const set = <K extends keyof TargetDraft>(key: K, value: TargetDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const kubeconfig = target?.kubeconfig ?? null;

  const save = async () => {
    setSubmitted(true);
    if (Object.keys(draftErrors(draft)).length > 0) return;
    setSaving(true);
    setError(null);
    try {
      let name = target?.name ?? draft.name.trim();
      if (target) {
        const patch = draftPatch(draft, target);
        if (Object.keys(patch).length > 0) await api.updateExecutionTarget(target.name, patch);
        name = draft.name.trim();
      } else {
        await api.createExecutionTarget(draftBody(draft));
      }
      if (draft.authMethod === 'kubeconfig' && draft.kubeconfig.trim()) await api.setExecutionTargetKubeconfig(name, draft.kubeconfig);
      onSaved();
    } catch (e) {
      setError(errorText(e));
      onChanged();
    } finally {
      setSaving(false);
    }
  };

  const runTest = () => {
    setTest({ status: 'testing', namespace: draft.namespace.trim() });
    api.testExecutionTargetConnection(connectionTestRequest(draft, target)).then(
      (result) => setTest({ status: 'done', result }),
      (e) => setTest({ status: 'error', message: errorText(e) }),
    );
  };

  const clearKubeconfig = () => {
    if (!target) return;
    api.clearExecutionTargetKubeconfig(target.name).then(() => {
      setReplacing(true);
      onChanged();
    }, toastError);
  };

  const readFile = (file: File | undefined) => {
    if (file) file.text().then((text) => set('kubeconfig', text), toastError);
  };

  const input = (key: DraftField, label: string, opts: { help?: ReactNode; short?: boolean; mono?: boolean; inputMode?: 'numeric'; placeholder?: string } = {}) => (
    <div>
      <label htmlFor={`target-${key}`} className={fieldLabel}>{label}</label>
      <input
        id={`target-${key}`}
        className={`${field} min-h-11 font-data ${opts.short ? 'sm:max-w-60' : ''}`}
        value={draft[key]}
        inputMode={opts.inputMode}
        placeholder={opts.placeholder}
        aria-invalid={errors[key] ? true : undefined}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => set(key, e.target.value)}
      />
      {errors[key] && <FieldError message={errors[key]} />}
      {opts.help && <p className={help}>{opts.help}</p>}
    </div>
  );

  const group = (title: string, children: ReactNode) => (
    <div className="border-t border-hairline py-[18px] first-of-type:border-t-0 first-of-type:pt-0">
      <h3 className="mb-3 text-[13px] font-bold">{title}</h3>
      <div className="flex max-w-xl flex-col gap-4">{children}</div>
    </div>
  );

  return (
    <section className={`${card} p-5`} aria-label={target ? `Edit ${target.name}` : 'Add Kubernetes target'}>
      <h2 className={sectionTitle}>{target ? 'Edit Kubernetes target' : 'Add Kubernetes target'}</h2>
      <p className="mb-4 mt-0.5 text-muted">{target ? 'Changes apply to pods started after you save.' : 'Prove the connection works before enabling it.'}</p>

      {group('Identity', (
        <>
          {input('name', 'Name', { help: <>Used in <code className={codeInline}>runs_on</code>. Renaming breaks workflows that name it.</> })}
          <Switch checked={draft.enabled} onChange={(v) => set('enabled', v)}>Enabled</Switch>
        </>
      ))}

      {group('Cluster access', (
        <>
          <div>
            <span id="target-method-label" className={fieldLabel}>Method</span>
            <div role="radiogroup" aria-labelledby="target-method-label" className="inline-flex overflow-hidden rounded-md border border-edge">
              {([['kubeconfig', 'Kubeconfig Secret'], ['in-cluster', 'In-cluster service account']] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={draft.authMethod === value}
                  className={`inline-flex min-h-11 items-center px-3.5 font-medium ${draft.authMethod === value ? 'bg-accent-tint font-semibold text-accent' : 'bg-field text-muted hover:text-ink'}`}
                  onClick={() => set('authMethod', value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className={help}>Use the service account when Harmonic itself runs in this cluster.</p>
          </div>
          {draft.authMethod === 'kubeconfig' && (
            <div>
              <span className={fieldLabel}>Kubeconfig</span>
              {kubeconfig?.set && (
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className={`${statePillShape} gap-1.5 bg-merged-tint text-merged`}>
                    <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
                    set
                  </span>
                  <code className={codeInline}>{kubeconfig.secretName}</code>
                  {kubeconfig.updatedAt && <span className="text-small text-muted">last replaced {new Date(kubeconfig.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>}
                </div>
              )}
              {kubeconfig?.set && !replacing && (
                <div className="mt-2 flex gap-2">
                  <button type="button" className={smallBtn} onClick={() => setReplacing(true)}>Replace…</button>
                  <button type="button" className={smallBtn} onClick={clearKubeconfig}>Clear</button>
                </div>
              )}
              {replacing && (
                <div className="mt-2">
                  <textarea
                    aria-label="Kubeconfig contents"
                    className={`${field} min-h-32 font-data text-small`}
                    value={draft.kubeconfig}
                    placeholder="Paste a kubeconfig, or choose a file"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => set('kubeconfig', e.target.value)}
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label className={`${smallBtn} cursor-pointer`}>
                      Choose file…
                      <input type="file" className="sr-only" onChange={(e) => readFile(e.target.files?.[0])} />
                    </label>
                    {kubeconfig?.set && (
                      <button type="button" className={smallBtn} onClick={() => { setReplacing(false); set('kubeconfig', ''); }}>Cancel replace</button>
                    )}
                  </div>
                </div>
              )}
              <p className={help}>Stored as a Secret and never shown again after you save it.</p>
            </div>
          )}
          {input('namespace', 'Namespace')}
        </>
      ))}

      {group('Pod', (
        <>
          {input('defaultImage', 'Default pod image', { help: <>A workflow or a Step can override it with <code className={codeInline}>image:</code>. Credentials baked into an image are refused; supply them as Secrets in Credentials.</> })}
          {input('cpu', 'CPU', { short: true })}
          {input('memory', 'Memory', { short: true })}
        </>
      ))}

      {group('Repository Proxy', input('repositoryProxyUrl', 'Repository Proxy URL', { help: <>One Repository Proxy per cluster. Install it from <code className={codeInline}>deploy/kubernetes/repository-proxy.yaml</code>.</> }))}

      {target && <RepositoryProxyKey target={target} onRotated={onChanged} />}

      {group('Concurrency', input('concurrencyLimit', 'Concurrency limit', { short: true, inputMode: 'numeric', help: <>Pods at once on this target. Separate from the Host Ceiling, which bounds <code className={codeInline}>local</code> only.</> }))}

      <hr className="my-5 border-hairline" />
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={btnGhost} disabled={!canTestConnection(draft, target) || test.status === 'testing'} onClick={runTest}>Test connection</button>
        <span className="text-small text-muted">Lists pods in the namespace using the access above. Nothing is created.</span>
      </div>
      <TestResult state={test} />

      {error && <p role="alert" className="mt-4 text-fail">{error}</p>}
      <div className="-mx-5 -mb-5 mt-5 flex flex-wrap items-center gap-2.5 border-t border-hairline px-5 py-3">
        {target && <button type="button" className={`${btnQuietDestructive} !text-fail`} onClick={() => onDelete(target)}>Delete target…</button>}
        <span className="flex-1" />
        <button type="button" className={btnQuiet} onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="button" className={btnPrimary} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save target'}</button>
      </div>
    </section>
  );
}

function TestResult({ state }: { state: TestState }) {
  if (state.status === 'idle') return null;
  const base = 'mt-3 flex items-start gap-2.5 rounded-md px-3 py-2.5 text-[13px]';
  if (state.status === 'testing') {
    return (
      <div role="status" className={`${base} border border-hairline bg-sunken`}>
        <span aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 animate-spin rounded-full border-2 border-edge border-t-accent motion-reduce:animate-none" />
        <span><Parts parts={testingMessage(state.namespace)} /></span>
      </div>
    );
  }
  if (state.status === 'error') {
    return <p role="alert" className="mt-3 text-fail">{state.message}</p>;
  }
  const panel = resultPanel(state.result);
  const ok = panel.tone === 'ok';
  return (
    <div role={ok ? 'status' : 'alert'} className={`${base} ${ok ? 'bg-merged-tint' : 'bg-fail-tint'} text-ink`}>
      <span className={`mt-0.5 shrink-0 ${ok ? 'text-merged' : 'text-fail'}`}>
        <Icon name={ok ? 'check' : 'x-circle'} />
      </span>
      <span>
        <b className="font-semibold">{panel.title}</b> <Parts parts={panel.body} />
        <span className="mt-0.5 block text-small text-muted"><Parts parts={panel.why} /></span>
      </span>
    </div>
  );
}
