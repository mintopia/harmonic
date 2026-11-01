// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Tabs } from '../web/src/components/Tabs.js';
import { sectionsForTab } from '../web/src/components/settings-schema.js';
import { SettingsForm } from '../web/src/components/SettingsForm.js';
import { cleanup, makeConfig, makeWorkspace, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

describe('settings prompts layout', () => {
  it('renders the Prompts settings as the Find, Edit and Check impact steps', () => {
    expect(sectionsForTab('global', 'prompts').map((s) => s.step)).toEqual(['find', 'edit', 'impact']);
    expect(sectionsForTab('workspace', 'prompts')).toEqual([]);
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
  const mountTab = async (surface: 'global' | 'workspace', tab: 'execution', step: string | null = null) => {
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
        step,
        onStep: () => {},
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
    let text = '';
    const hosts: HTMLElement[] = [];
    for (const step of ['workflow', 'agent', 'where', 'limits']) {
      const stepHost = await mountTab(surface, 'execution', step);
      text += stepHost.textContent ?? '';
      hosts.push(stepHost);
      await cleanup();
    }
    const host = { querySelector: (selector: string) => hosts.map((h) => h.querySelector(selector)).find(Boolean) ?? null };
    for (const label of ['Attempt limit', 'Merge fate', 'Continue attempts', 'Unattended drive']) expect(text).not.toContain(label);
    for (const id of ['settings-max-attempts', 'workspace-max-attempts', 'settings-merge-fate', 'workspace-merge-fate', 'settings-continue-attempts', 'workspace-continue-attempts']) {
      expect(host.querySelector(`#${id}`), id).toBeNull();
    }
    expect(text).toContain('Session reuse');
    expect(text).not.toContain('before the epic merges');
    expect(text).not.toContain('+ Add critic');
  });

  it.each(['global', 'workspace'] as const)('homes every Execution setting across Where and Limits on the %s surface', async (surface) => {
    const where = await mountTab(surface, 'execution', 'where');
    expect(where.textContent).toContain('Checkout isolation');
    expect(where.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    await cleanup();
    const limits = await mountTab(surface, 'execution', 'limits');
    const text = limits.textContent ?? '';
    for (const heading of ['Starting work', 'Bounding an Attempt', 'Agent sessions']) expect(text).toContain(heading);
    for (const row of ['Auto-runner', 'Budget guardrail', 'Progress guardrail', 'Tool timeout', 'Merge-conflict turns', 'Session reuse', 'Agent Messages', 'maxAttempts']) {
      expect(text, row).toContain(row);
    }
    expect(text).toContain(surface === 'global' ? 'Host ceiling' : 'Concurrency cap');
    await cleanup();
    const agent = await mountTab(surface, 'execution', 'agent');
    expect(agent.textContent).not.toContain('Isolation mode');
    expect(agent.textContent).not.toContain('Agent Messages');
  });
});
