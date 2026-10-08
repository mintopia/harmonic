// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Tabs } from '../web/src/components/Tabs.js';
import { SettingsForm } from '../web/src/components/SettingsForm.js';
import { cleanup, makeConfig, mountComponent } from './component-smoke-harness.js';

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
