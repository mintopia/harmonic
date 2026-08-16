import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AppConfig, Workspace } from '../types';
import { btnGhost, btnQuietDestructive, displayTitle, field, selectField } from '../ui';
import { FieldError, SettingsSection, fieldLabel, parseFieldErrors } from './SettingsSection';
import { FloatingSaveBar } from './FloatingSaveBar';
import { InheritField } from './InheritField';
import { Switch } from './Switch';
import { Modal } from './Modal';

/**
 * Per-Workspace settings page (ADR-0012, issue #64): the Workspace half of the
 * settings split, scoped to the active Workspace (the rail item that opens it
 * follows the switcher). It holds the Workspace's own identity — name, Working
 * Directory (read-only), tracker mirroring — plus its overrides of the global
 * defaults (Task defaults, the Auto-Runner cap and enable), each rendered
 * through the inheritance field (#65) so inheriting-vs-overriding is explicit
 * and reversible. Delete lives here too, behind a naming Modal confirm.
 *
 * Overrides resolve at read time (#60); this page only reads and writes them.
 * The whole set saves together on the floating bar, mirroring SettingsPage.
 */
export function WorkspaceSettingsPage({
  workspace,
  config,
  blockedByRunningTask,
  onSaved,
  onDeleted,
}: {
  workspace: Workspace;
  config: AppConfig;
  /** The active Workspace has a running Task, so delete must refuse (the server
   * 409s regardless; this disables the confirm and says why up front). */
  blockedByRunningTask: boolean;
  onSaved: (workspace: Workspace) => void;
  onDeleted: (id: number) => void;
}) {
  const [pristine, setPristine] = useState<Workspace>(workspace);
  const [local, setLocal] = useState<Workspace>(workspace);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Switching Workspace re-scopes the page: reseed from the new one and drop any
  // half-made edits to the old (they belonged to a different Workspace).
  useEffect(() => {
    setPristine(workspace);
    setLocal(workspace);
    setError(null);
    setFieldErrors({});
  }, [workspace]);

  const dirty = JSON.stringify(local) !== JSON.stringify(pristine);

  const set = <K extends keyof Workspace>(key: K, value: Workspace[K]) =>
    setLocal((w) => ({ ...w, [key]: value }));

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
      // Working Directory is read-only here (it is Workspace identity, not a
      // setting), so it's left out of the patch. Overrides go as-is — `null`
      // clears one back to inherit, a value overrides.
      const updated = await api.updateWorkspace(local.id, {
        name: local.name,
        trackerEnabled: local.trackerEnabled,
        trackerPollIntervalSeconds: local.trackerPollIntervalSeconds,
        harness: local.harness,
        model: local.model,
        chatHarness: local.chatHarness,
        chatModel: local.chatModel,
        isolationMode: local.isolationMode,
        priority: local.priority,
        maxConcurrentRuns: local.maxConcurrentRuns,
        autoRunnerEnabled: local.autoRunnerEnabled,
      });
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

  // The model override's inherited value and option list track the *effective*
  // harness (mirrors TaskService.resolveExecution): overriding the harness
  // repoints the model to that harness's default and models.
  const effectiveHarness = local.harness ?? config.defaults.harness;
  const harnessConfig = config.harnesses[effectiveHarness];
  const inheritedModel = harnessConfig?.defaultModel ?? '';
  const models = harnessConfig?.models ?? [];

  // Chat defaults resolve independently of the Task defaults (ADR-0012): the
  // effective chat harness drives the model option list, but the inherited
  // model is the global chat model (a standalone value, not the harness's
  // defaultModel) — chat and Tasks can pin different models of one Harness.
  const effectiveChatHarness = local.chatHarness ?? config.chat.harness;
  const chatModels = config.harnesses[effectiveChatHarness]?.models ?? [];

  return (
    <div>
      <div className="max-w-3xl">
        <h2 className={displayTitle}>Workspace</h2>
        <p className="mt-1 text-muted">
          Settings for <span className="font-semibold text-ink">{pristine.name}</span> — its identity and its
          overrides of the global defaults. Overridable fields inherit the default until you turn an override on.
        </p>
      </div>

      <div className="mt-5 flex flex-col gap-4">
        <SettingsSection title="Identity" description="This Workspace's name and the project directory it points at.">
          <div className="grid gap-3.5 sm:grid-cols-2">
            <div>
              <label className={fieldLabel} htmlFor="workspace-name">Name</label>
              <input
                id="workspace-name"
                className={field}
                value={local.name}
                onChange={(e) => set('name', e.target.value)}
              />
              <FieldError message={fieldErrors['name']} />
            </div>
            <div>
              <span className={fieldLabel}>Working directory</span>
              <p className="truncate font-data text-ink" title={local.workingDir}>
                {local.workingDir}
              </p>
              <p className="mt-1 text-small text-muted">
                Fixed once a Workspace is created — make a new Workspace to point at a different repo.
              </p>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          title="Tracker mirroring"
          description="Poll this Workspace's issue tracker and mirror its issues onto the board as Tasks. Needs docs/agents/issue-tracker.md in the repo and gh (GitHub) auth."
        >
          <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
            <div>
              <span className={fieldLabel}>Enabled</span>
              <div className="pt-1">
                <Switch
                  checked={local.trackerEnabled}
                  onChange={(trackerEnabled) => set('trackerEnabled', trackerEnabled)}
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
                className={`${field} w-28 font-data`}
                value={local.trackerPollIntervalSeconds}
                onChange={(e) => set('trackerPollIntervalSeconds', Number(e.target.value))}
              />
              <FieldError message={fieldErrors['trackerPollIntervalSeconds']} />
            </div>
            <div>
              <span className={fieldLabel}>Resolved tracker</span>
              <ResolvedTrackerValue workspace={pristine} />
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          title="Auto-runner"
          description="Whether ready Tasks here run unattended, and how many at once. Both inherit the global defaults until overridden; a cap override can never exceed the Machine Ceiling."
        >
          <div className="flex flex-col gap-4 sm:max-w-md">
            <div>
              <InheritField
                label="Enabled"
                value={local.autoRunnerEnabled}
                inherited={config.autoRunner.enabled}
                format={(v) => (v ? 'On' : 'Off')}
                onChange={(autoRunnerEnabled) => set('autoRunnerEnabled', autoRunnerEnabled)}
              >
                {({ value, onChange }) => (
                  <Switch checked={value} onChange={onChange}>
                    Run ready tasks unattended
                  </Switch>
                )}
              </InheritField>
              <FieldError message={fieldErrors['autoRunnerEnabled']} />
            </div>
            <div>
              <InheritField
                label="Max concurrent runs"
                htmlFor="workspace-max-runs"
                value={local.maxConcurrentRuns}
                inherited={config.autoRunner.maxConcurrentRuns}
                onChange={(maxConcurrentRuns) => set('maxConcurrentRuns', maxConcurrentRuns)}
              >
                {({ id, value, onChange }) => (
                  <input
                    id={id}
                    type="number"
                    min={1}
                    // The ceiling is the hard limit an override can't breach
                    // (ADR-0012); clamping is read-time (#60), this just guides.
                    max={config.autoRunner.maxConcurrentRuns}
                    className={`${field} w-28 font-data`}
                    value={value}
                    onChange={(e) => onChange(Number(e.target.value))}
                  />
                )}
              </InheritField>
              <FieldError message={fieldErrors['maxConcurrentRuns']} />
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          title="Task defaults"
          description="Pre-filled into every new Task in this Workspace. Each inherits the global default until overridden; a Task can still override them one by one."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <InheritField
                label="Harness"
                htmlFor="workspace-harness"
                value={local.harness}
                inherited={config.defaults.harness}
                onChange={(harness) => set('harness', harness)}
              >
                {({ id, value, onChange }) => (
                  <select id={id} className={`${selectField} w-full`} value={value} onChange={(e) => onChange(e.target.value)}>
                    {Object.keys(config.harnesses).map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                    {value && !config.harnesses[value] && <option value={value}>{value} (not configured)</option>}
                  </select>
                )}
              </InheritField>
              <FieldError message={fieldErrors['harness']} />
            </div>
            <div>
              <InheritField
                label="Model"
                htmlFor="workspace-model"
                value={local.model}
                inherited={inheritedModel}
                onChange={(model) => set('model', model)}
              >
                {({ id, value, onChange }) => (
                  <select id={id} className={`${selectField} w-full`} value={value} onChange={(e) => onChange(e.target.value)}>
                    {models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                    {value && !models.includes(value) && (
                      <option value={value}>{value} (not in models list)</option>
                    )}
                  </select>
                )}
              </InheritField>
              <FieldError message={fieldErrors['model']} />
            </div>
            <div>
              <InheritField
                label="Isolation mode"
                htmlFor="workspace-isolation"
                value={local.isolationMode}
                inherited={config.defaults.isolationMode}
                onChange={(isolationMode) => set('isolationMode', isolationMode)}
              >
                {({ id, value, onChange }) => (
                  <select
                    id={id}
                    className={`${selectField} w-full`}
                    value={value}
                    onChange={(e) => onChange(e.target.value as 'direct' | 'worktree')}
                  >
                    <option value="direct">direct</option>
                    <option value="worktree">worktree</option>
                  </select>
                )}
              </InheritField>
              <FieldError message={fieldErrors['isolationMode']} />
            </div>
            <div>
              <InheritField
                label="Priority"
                htmlFor="workspace-priority"
                value={local.priority}
                inherited={config.defaults.priority}
                onChange={(priority) => set('priority', priority)}
              >
                {({ id, value, onChange }) => (
                  <select
                    id={id}
                    className={`${selectField} w-full`}
                    value={value}
                    onChange={(e) => onChange(e.target.value as 'high' | 'normal' | 'low')}
                  >
                    <option value="high">high</option>
                    <option value="normal">normal</option>
                    <option value="low">low</option>
                  </select>
                )}
              </InheritField>
              <FieldError message={fieldErrors['priority']} />
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          title="Chat defaults"
          description="The Harness and model new Conversations in this Workspace start with. Each inherits the global chat default until overridden; every chat can still change them before its first turn."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <InheritField
                label="Harness"
                htmlFor="workspace-chat-harness"
                value={local.chatHarness}
                inherited={config.chat.harness}
                onChange={(chatHarness) => set('chatHarness', chatHarness)}
              >
                {({ id, value, onChange }) => (
                  <select id={id} className={`${selectField} w-full`} value={value} onChange={(e) => onChange(e.target.value)}>
                    {Object.keys(config.harnesses).map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                    {value && !config.harnesses[value] && <option value={value}>{value} (not configured)</option>}
                  </select>
                )}
              </InheritField>
              <FieldError message={fieldErrors['chatHarness']} />
            </div>
            <div>
              <InheritField
                label="Model"
                htmlFor="workspace-chat-model"
                value={local.chatModel}
                inherited={config.chat.model}
                onChange={(chatModel) => set('chatModel', chatModel)}
              >
                {({ id, value, onChange }) => (
                  <select id={id} className={`${selectField} w-full`} value={value} onChange={(e) => onChange(e.target.value)}>
                    {chatModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                    {value && !chatModels.includes(value) && (
                      <option value={value}>{value} (not in models list)</option>
                    )}
                  </select>
                )}
              </InheritField>
              <FieldError message={fieldErrors['chatModel']} />
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          title="Delete workspace"
          description="Removes this Workspace and everything on its board — Tasks, Runs, and Conversations. This cannot be undone."
        >
          <button
            type="button"
            className={btnGhost}
            onClick={() => setConfirmingDelete(true)}
          >
            Delete workspace…
          </button>
          {blockedByRunningTask && (
            <p className="mt-2 text-small text-muted">
              A Task is running here — stop it before this Workspace can be deleted.
            </p>
          )}
        </SettingsSection>
      </div>

      {dirty && <FloatingSaveBar error={error} saving={saving} onDiscard={discard} onSave={save} />}

      {confirmingDelete && (
        <DeleteWorkspaceDialog
          workspace={pristine}
          blockedByRunningTask={blockedByRunningTask}
          onClose={() => setConfirmingDelete(false)}
          onDeleted={onDeleted}
        />
      )}
    </div>
  );
}

/** Friendly phrasing per failure code, with the raw reason kept as a tooltip. */
const RESOLVE_FAILURE_LABEL: Record<string, string> = {
  'no-declaration': 'No tracker declared',
  unsupported: 'Unsupported tracker',
  misconfigured: 'Tracker misconfigured',
};

/**
 * The read-only Resolved Tracker (issue #83): the resolved adapter label when
 * it resolves, the reason it can't when it doesn't, or a hint that tracking is
 * off. Read straight from the server (the pristine Workspace), not local edits —
 * it recomputes only when a save re-syncs the poll loop.
 */
function ResolvedTrackerValue({ workspace }: { workspace: Workspace }) {
  const resolved = workspace.resolvedTracker;
  if (!resolved) {
    return (
      <p className="pt-1 text-small text-muted">
        {workspace.trackerEnabled ? 'Resolving…' : 'Enable mirroring to resolve the tracker.'}
      </p>
    );
  }
  if (resolved.ok) {
    return <p className="pt-1 font-medium text-ink">{resolved.label}</p>;
  }
  const friendly = (resolved.code && RESOLVE_FAILURE_LABEL[resolved.code]) ?? 'Cannot resolve tracker';
  return (
    <p className="pt-1 text-fail" title={resolved.reason ?? undefined}>
      {friendly}
    </p>
  );
}

/**
 * Naming Modal confirm for delete (issue #64 acceptance). The confirm is
 * disabled up front when a Task is running; the server's 409 is the backstop,
 * surfaced inline if it fires anyway (e.g. a Task started between load and here).
 */
function DeleteWorkspaceDialog({
  workspace,
  blockedByRunningTask,
  onClose,
  onDeleted,
}: {
  workspace: Workspace;
  blockedByRunningTask: boolean;
  onClose: () => void;
  onDeleted: (id: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteWorkspace(workspace.id);
      onDeleted(workspace.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal label={`Delete workspace ${workspace.name}`} onClose={onClose} className="max-w-md">
      <div className="p-5">
        <h2 className={`${displayTitle} mb-2 pr-6`}>Delete workspace</h2>
        <p className="text-muted">
          Delete <span className="font-semibold text-ink">{workspace.name}</span> and everything on its board —
          its Tasks, Runs, and Conversations. This cannot be undone.
        </p>
        {blockedByRunningTask && (
          <p className="mt-3 text-fail">A Task is running here. Stop it before deleting this Workspace.</p>
        )}
        {error && <p className="mt-3 text-fail">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`${btnQuietDestructive} px-3.5 py-2`}
            onClick={confirm}
            disabled={busy || blockedByRunningTask}
          >
            {busy ? 'Deleting…' : `Delete ${workspace.name}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
