// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Tabs } from '../web/src/components/Tabs.js';
import { SettingsForm } from '../web/src/components/SettingsForm.js';
import { cleanup, makeConfig, makeWorkspace, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

describe('settings layout (issue #554)', () => {
  it('gives verification the full desktop settings grid', async () => {
    const config = makeConfig();
    const host = await mountComponent(
      createElement(SettingsForm, {
        title: 'Settings',
        intro: 'Configure Harmonic.',
        tabs: [{ id: 'verification', label: 'Verification' }],
        tab: 'verification',
        onTab: () => {},
        ctx: {
          surface: 'global',
          config,
          baseline: config,
          setConfig: () => {},
          errors: {},
          harnessPermissionModes: {},
          channels: { list: [], onToggleEvent: () => {}, onCreated: () => {}, onDeleted: () => {} },
        },
        dirty: false,
        saving: false,
        error: null,
        onSave: () => {},
        onDiscard: () => {},
      }),
    );

    expect(host.querySelector('section')?.className).toContain('xl:col-span-2');
  });
});


describe('settings prompts layout', () => {
  it('renders the Prompts tab as one bare full-width panel organised by anatomy', async () => {
    const config = makeConfig();
    const host = await mountComponent(
      createElement(SettingsForm, {
        title: 'Settings',
        intro: 'Configure Harmonic.',
        tabs: [{ id: 'prompts', label: 'Prompts' }],
        tab: 'prompts',
        onTab: () => {},
        ctx: {
          surface: 'global',
          config,
          baseline: config,
          setConfig: () => {},
          errors: {},
          harnessPermissionModes: {},
          channels: { list: [], onToggleEvent: () => {}, onCreated: () => {}, onDeleted: () => {} },
        },
        dirty: false,
        saving: false,
        error: null,
        onSave: () => {},
        onDiscard: () => {},
      }),
    );

    const panel = host.querySelector('[role="tabpanel"]');
    expect(panel?.className).toContain('xl:grid-cols-2');
    expect(panel?.className).not.toContain('xl:columns-2');
    expect(panel?.querySelector('[role="tablist"][aria-label="Prompts the agent receives"]')).not.toBeNull();
    expect(panel?.firstElementChild?.className).toContain('xl:col-span-2');
  });
});


describe('settings tab keyboard navigation', () => {
  it('keeps one tab in the tab order and activates focused arrow and endpoint destinations', async () => {
    function TabExample() {
      const [active, setActive] = useState('general');
      return createElement(Tabs, {
        tabs: [{ id: 'general', label: 'General' }, { id: 'execution', label: 'Execution' }, { id: 'archive', label: 'Archive & Export' }],
        active,
        onChange: setActive,
        label: 'Settings sections',
      });
    }
    const host = await mountComponent(createElement(TabExample));
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const general = tabs[0];
    expect(general).toBeDefined();
    general?.focus();
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    for (const [key, selected] of [['ArrowLeft', 'archive'], ['ArrowRight', 'general'], ['End', 'archive'], ['Home', 'general'], ['ArrowRight', 'execution']]) {
      await act(async () => {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });
      expect(document.activeElement?.id).toBe(`settings-tab-${selected}`);
      expect(host.querySelector('[aria-selected="true"]')?.id).toBe(`settings-tab-${selected}`);
      expect(tabs.filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
    }
  });
});


describe('settings Execution tab without Ticket-side execution controls (ADR-0055)', () => {
  const channels = { list: [], onToggleEvent: () => {}, onCreated: () => {}, onDeleted: () => {} };
  const mountTab = async (surface: 'global' | 'workspace', tab: 'execution' | 'verification') => {
    const config = makeConfig();
    const workspace = makeWorkspace();
    const ctx =
      surface === 'global'
        ? { surface: 'global' as const, config, baseline: config, setConfig: () => {}, errors: {}, harnessPermissionModes: {}, channels }
        : {
            surface: 'workspace' as const,
            config,
            workspace,
            pristineWorkspace: workspace,
            setWorkspace: () => {},
            errors: {},
            blockedByRunningTask: false,
            onRequestDelete: () => {},
          };
    return mountComponent(
      createElement(SettingsForm, {
        title: 'Settings',
        intro: 'Configure Harmonic.',
        tabs: [{ id: tab, label: tab }],
        tab,
        onTab: () => {},
        ctx,
        dirty: false,
        saving: false,
        error: null,
        onSave: () => {},
        onDiscard: () => {},
      }),
    );
  };

  it.each(['global', 'workspace'] as const)('renders none of the removed controls on the %s Execution tab', async (surface) => {
    const host = await mountTab(surface, 'execution');
    const text = host.textContent ?? '';
    for (const label of ['Attempt limit', 'Merge fate', 'Continue attempts', 'Unattended drive']) expect(text).not.toContain(label);
    for (const id of ['settings-max-attempts', 'workspace-max-attempts', 'settings-merge-fate', 'workspace-merge-fate', 'settings-continue-attempts', 'workspace-continue-attempts']) {
      expect(host.querySelector(`#${id}`), id).toBeNull();
    }
    expect(text).toContain('Session reuse');
  });

  it.each(['global', 'workspace'] as const)('keeps Epic verification controls and drops the Task ones on the %s verification tab', async (surface) => {
    const host = await mountTab(surface, 'verification');
    const text = host.textContent ?? '';
    expect(host.querySelector('[role="tablist"][aria-label="Verification scope"]')).toBeNull();
    expect(text).toContain('before the epic merges');
    expect(text).not.toContain('before the task merges');
    expect(text).not.toContain('Post-merge');
    expect(host.querySelector('[id^="settings-task-"], [id^="workspace-task-"]')).toBeNull();
    expect(text).toContain('+ Add command');
    expect(text).toContain('+ Add critic');
  });
});
