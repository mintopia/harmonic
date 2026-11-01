import { useCallback, useState } from 'react';
import type { SettingTab } from '../../src/domain/settings-registry.js';
import { formatSettingsLocation, parseSettingsLocation } from './settings-steps-model';

export function useSettingsLocation(tabs: readonly SettingTab[]) {
  const [state, setState] = useState(() => {
    const read = parseSettingsLocation(window.location.search, tabs);
    return { tab: read.tab ?? tabs[0] ?? 'general', step: read.step };
  });

  const write = useCallback((tab: SettingTab, step: string | null) => {
    setState({ tab, step });
    const search = formatSettingsLocation(window.location.search, tab, step ?? '');
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}${window.location.hash}`);
  }, []);

  const setTab = useCallback((tab: SettingTab) => write(tab, null), [write]);
  const setStep = useCallback((step: string) => write(state.tab, step), [write, state.tab]);
  return { tab: state.tab, step: state.step, setTab, setStep };
}
