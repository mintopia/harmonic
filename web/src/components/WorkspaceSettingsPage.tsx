import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Workspace } from '../types';
import { btnDestructive, btnGhost, displayTitle, field } from '../ui';
import { parseFieldErrors } from './SettingsSection';
import { Modal } from './Modal';
import { SettingsForm } from './SettingsForm';
import type { AppConfig } from '../types';
import type { WorkspaceRenderCtx } from './settings-schema';
import { workspaceTabs, type SettingTab } from '../../../src/domain/settings-registry.js';

/**
 * The per-Workspace settings surface: a thin data shell over the shared
 * {@link SettingsForm} engine (ADR-0044 Decision G). It owns the override buffer
 * and the field PATCH, and renders the *same* {@link SETTINGS_SCHEMA} as the
 * global page with the inherit layer on and the `global-only` tabs filtered out.
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
  const [tab, setTab] = useState<SettingTab>('general');

  useEffect(() => {
    setPristine(workspace);
    setLocal(workspace);
    setError(null);
    setFieldErrors({});
  }, [workspace]);

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
        conflictResolveTurns: local.conflictResolveTurns,
        maxConcurrentRuns: local.maxConcurrentRuns,
        autoRunnerEnabled: local.autoRunnerEnabled,
        maxAttempts: local.maxAttempts,
        contextReuseTokenLimit: local.contextReuseTokenLimit,
        verificationCommand: local.verificationCommand,
        reviewEnabled: local.reviewEnabled,
        reviewPrompt: local.reviewPrompt,
        reviewModel: local.reviewModel,
        reviewHarness: local.reviewHarness,
        guardrailBudget: local.guardrailBudget,
        guardrailProgress: local.guardrailProgress,
        toolTimeoutMinutes: local.toolTimeoutMinutes,
        drivePrompt: local.drivePrompt,
        driveUnattendedReminder: local.driveUnattendedReminder,
        driveContinuePrompt: local.driveContinuePrompt,
        driveMergeFate: local.driveMergeFate,
        driveContinueAttempts: local.driveContinueAttempts,
        taskPrompt: local.taskPrompt,
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

  const ctx: WorkspaceRenderCtx = {
    surface: 'workspace',
    config,
    workspace: local,
    pristineWorkspace: pristine,
    setWorkspace: setLocal,
    errors: fieldErrors,
    blockedByRunningTask,
    onRequestDelete: () => setConfirmingDelete(true),
  };

  return (
    <SettingsForm
      title="Workspace"
      intro={
        <>
          Settings for <span className="font-semibold text-ink">{pristine.name}</span> — its identity and its overrides
          of the global defaults. Overridable fields inherit the default until you turn an override on.
        </>
      }
      tabs={workspaceTabs()}
      tab={tab}
      onTab={setTab}
      ctx={ctx}
      dirty={dirty}
      saving={saving}
      error={error}
      onSave={save}
      onDiscard={discard}
    >
      {confirmingDelete && (
        <DeleteWorkspaceDialog
          workspace={pristine}
          blockedByRunningTask={blockedByRunningTask}
          onClose={() => setConfirmingDelete(false)}
          onDeleted={onDeleted}
        />
      )}
    </SettingsForm>
  );
}

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
  const [typed, setTyped] = useState('');

  const nameMatches = typed.trim() === workspace.name;
  const canDelete = nameMatches && !blockedByRunningTask && !busy;

  const confirm = async () => {
    if (!canDelete) return;
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
          its Tasks, Attempts, and Conversations. This cannot be undone.
        </p>
        <label htmlFor="delete-workspace-name" className="mt-4 block text-small text-muted">
          Type <span className="font-semibold text-ink">{workspace.name}</span> to confirm.
        </label>
        <input
          id="delete-workspace-name"
          autoFocus
          autoComplete="off"
          className={`${field} mt-1.5`}
          value={typed}
          placeholder={workspace.name}
          disabled={busy}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              confirm();
            }
          }}
        />
        {blockedByRunningTask && (
          <p className="mt-3 text-fail">A Task is running here. Stop it before deleting this Workspace.</p>
        )}
        {error && <p className="mt-3 text-fail">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={btnDestructive} onClick={confirm} disabled={!canDelete}>
            {busy ? 'Deleting…' : `Delete ${workspace.name}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
