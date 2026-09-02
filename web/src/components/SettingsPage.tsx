import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AppConfig, Channel } from '../types';
import { btnGhost } from '../ui';
import { changedChannelEvents, channelsDirty, toggleChannelEvent } from '../channels-save-model';
import { parseFieldErrors } from './SettingsSection';
import { SettingsForm } from './SettingsForm';
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
  const [local, setLocal] = useState<AppConfig | null>(null);
  const [pristineChannels, setPristineChannels] = useState<Channel[]>([]);
  const [localChannels, setLocalChannels] = useState<Channel[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<SettingTab>('general');

  useEffect(() => {
    api.configLayers().then(({ baseline, global }) => {
      setBaseline(baseline);
      setPristine(global);
      setLocal(global);
    });
    api
      .channels()
      .then(({ channels }) => {
        setPristineChannels(channels);
        setLocalChannels(channels);
      })
      .catch(() => {});
  }, []);

  if (!local || !pristine || !baseline) return null;

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
    try {
      const updated = await api.replaceConfig(local);
      setPristine(updated);
      setLocal(updated);
      let savedChannels = pristineChannels;
      for (const { id, events } of changedChannelEvents(localChannels, pristineChannels)) {
        await api.updateChannel(id, { events });
        savedChannels = savedChannels.map((c) => (c.id === id ? { ...c, events } : c));
        setPristineChannels(savedChannels);
      }
      onSaved(updated);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      setFieldErrors(parseFieldErrors(message));
    } finally {
      setSaving(false);
    }
  };

  const revertAll = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.revertConfig();
      setPristine(updated);
      setLocal(updated);
      onSaved(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
      intro="Defaults, harnesses, and how the runner behaves. Changes stage until you save; only side-effect actions — password changes, adding or removing a channel — apply immediately."
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
        <button type="button" className={btnGhost} disabled={saving} onClick={revertAll}>
          Revert all to distributed
        </button>
      }
    />
  );
}
