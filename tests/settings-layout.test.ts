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


describe('settings prompts layout (issue #808)', () => {
  it('packs prompt sections as masonry columns with full-width fragments last', async () => {
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

    expect(host.querySelector('[role="tabpanel"]')?.className).toContain('xl:columns-2');
    const sections = [...host.querySelectorAll('section')];
    const titles = sections.map((s) => s.querySelector('h2')?.textContent);
    expect(titles).toEqual(['Task prompt', 'Drive prompt', 'Merge and Epic resolver prompts', 'Prompt fragments']);
    expect(sections.slice(0, 3).every((s) => s.className.includes('xl:break-inside-avoid'))).toBe(true);
    expect(sections[3]?.className).toContain('xl:[column-span:all]');
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
