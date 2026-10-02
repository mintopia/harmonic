import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AppConfig, Channel, ConfigLayers } from '../types';
import { btnGhost } from '../ui';
import { changedChannelEvents, channelsDirty, toggleChannelEvent } from '../channels-save-model';
import { humanizeSaveError, parseFieldErrors } from './SettingsSection';
import { firstPatternError, normalizeConfigExport } from '../archive-export-model';
import { SettingsForm } from './SettingsForm';
import { LoadError } from './LoadError';
import { ConfirmDialog } from './ConfirmDialog';
import type { GlobalRenderCtx } from './settings-schema';
import { SETTING_TABS, type SettingTab } from '../../../src/domain/settings-registry.js';

/**
 * The global settings surface: a thin data shell over the shared
 * {@link SettingsForm} engine. It owns the whole-config
 * buffer and the notification channels, and renders every field from the one
 * {@link SETTINGS_SCHEMA} with the inherit layer off.
 */
export function SettingsPage({ onSaved }: { onSaved: (config: AppConfig) => void }) {
  const [pristine, setPristine] = useState<AppConfig | null>(null);
  const [baseline, setBaseline] = useState<AppConfig | null>(null);
  const [harnessPermissionModes, setHarnessPermissionModes] = useState<ConfigLayers['harnessPermissionModes']>({});
  const [local, setLocal] = useState<AppConfig | null>(null);
  const [pristineChannels, setPristineChannels] = useState<Channel[]>([]);
  const [localChannels, setLocalChannels] = useState<Channel[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<SettingTab>('general');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [confirmingRevert, setConfirmingRevert] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([api.configLayers(), api.channels()])
      .then(([{ baseline, global, harnessPermissionModes }, { channels }]) => {
        if (!active) return;
        setBaseline(baseline);
        setPristine(global);
        setLocal(global);
        setHarnessPermissionModes(harnessPermissionModes);
        setPristineChannels(channels);
        setLocalChannels(channels);
      })
      .catch((e) => {
        if (active) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => { active = false; };
  }, [loadAttempt]);

  if (loadError) return <LoadError message={`settings: ${loadError}`} onRetry={() => { setLoadError(null); setLoadAttempt((n) => n + 1); }} />;
  if (!local || !pristine || !baseline) return <p role="status" className="p-4 text-muted">Loading settings…</p>;

  const dirty =
    JSON.stringify(local) !== JSON.stringify(pristine) || channelsDirty(localChannels, pristineChannels);

  const discard = () => {
    setLocal(pristine);
    setLocalChannels(pristineChannels);
    setError(null);
    setFieldErrors({});
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setFieldErrors({});
    const patternError = firstPatternError(local.export.redact.patterns);
    if (patternError) {
      setError(patternError);
      setSaving(false);
      return;
    }
    let configSaved = false;
    try {
      if (JSON.stringify(local) !== JSON.stringify(pristine)) {
        const updated = await api.replaceConfig(normalizeConfigExport(local));
        setPristine(updated);
        setLocal(updated);
        onSaved(updated);
        configSaved = true;
      }
      let savedChannels = pristineChannels;
      for (const { id, events } of changedChannelEvents(localChannels, pristineChannels)) {
        try {
          await api.updateChannel(id, { events });
        } catch (e) {
          throw new Error(`${configSaved ? 'Global settings were saved, but a notification channel failed to save.' : 'A notification channel failed to save.'} Retry to save the remaining channel changes: ${e instanceof Error ? e.message : String(e)}`);
        }
        savedChannels = savedChannels.map((c) => (c.id === id ? { ...c, events } : c));
        setPristineChannels(savedChannels);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(humanizeSaveError(message));
      setFieldErrors(parseFieldErrors(message));
    } finally {
      setSaving(false);
    }
  };

  const revertAll = async () => {
    setConfirmingRevert(false);
    setSaving(true);
    setError(null);
    setRevertError(null);
    setFieldErrors({});
    try {
      const updated = await api.revertConfig();
      setPristine(updated);
      setLocal(updated);
      onSaved(updated);
    } catch (e) {
      setRevertError(humanizeSaveError(e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  };

  const ctx: GlobalRenderCtx = {
    surface: 'global',
    config: local,
    baseline,
    setConfig: setLocal,
    errors: fieldErrors,
    harnessPermissionModes,
    channels: {
      list: localChannels,
      onToggleEvent: (id, event) => setLocalChannels((cs) => toggleChannelEvent(cs, id, event)),
      onCreated: (created) => {
        setPristineChannels((cs) => [...cs, created]);
        setLocalChannels((cs) => [...cs, created]);
      },
      onDeleted: (id) => {
        setPristineChannels((cs) => cs.filter((c) => c.id !== id));
        setLocalChannels((cs) => cs.filter((c) => c.id !== id));
      },
    },
  };

  return (
    <SettingsForm
      title="Settings"
      intro="Global defaults for harnesses, verification, and the runner"
      tabs={SETTING_TABS}
      tab={tab}
      onTab={setTab}
      ctx={ctx}
      dirty={dirty}
      saving={saving}
      error={error}
      onSave={save}
      onDiscard={discard}
      headerActions={
        <button type="button" className={btnGhost} disabled={saving} onClick={() => setConfirmingRevert(true)}>
          Revert all to distributed
        </button>
      }
    >
      {revertError && <p role="alert" className="mt-4 text-fail">{revertError}</p>}
      {confirmingRevert && (
        <ConfirmDialog
          label="Reset global settings"
          title="Revert all global settings?"
          confirmLabel="Revert all to distributed"
          tone="danger"
          onConfirm={revertAll}
          onCancel={() => setConfirmingRevert(false)}
        >
          <p>This immediately resets global settings to the distributed defaults. Workspaces that inherit these settings will use the defaults too. Unsaved global setting changes will be discarded.</p>
        </ConfirmDialog>
      )}
    </SettingsForm>
  );
}
