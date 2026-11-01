// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../web/src/api.js';
import { parseRoute, serializeRoute } from '../web/src/router-model.js';
import { SETTING_TABS } from '../src/domain/settings-registry.js';
import {
  TAB_STEPS,
  formatSettingsLocation,
  parseSettingsLocation,
  resolveStep,
  visibleSteps,
} from '../web/src/settings-steps-model.js';
import { SETTINGS_SCHEMA, sectionsForStep, stepsForSurface } from '../web/src/components/settings-schema.js';
import { SettingsForm } from '../web/src/components/SettingsForm.js';
import { ResolutionStrip } from '../web/src/components/ResolutionStrip.js';
import { cleanup, makeConfig, makeWorkspace, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

const TAB_IDS = SETTING_TABS.map((t) => t.id);

describe('settings tabs and steps', () => {
  it('lists the five tabs in the mockup order, with Security folded into General', () => {
    expect(SETTING_TABS.map((t) => t.label)).toEqual(['General', 'Running Tickets', 'Prompts', 'Integrations', 'Archive & Export']);
    expect(SETTINGS_SCHEMA.filter((s) => s.tab === 'general' && s.step === 'access').map((s) => s.title)).toEqual(['Access']);
  });

  it('gives every schema section a step declared for its tab', () => {
    for (const section of SETTINGS_SCHEMA) {
      expect(TAB_STEPS[section.tab].map((s) => s.id), `${section.tab}/${String(section.title)}`).toContain(section.step);
    }
  });

  it('hides steps with no content for the surface', () => {
    expect(stepsForSurface('global', 'execution').map((s) => s.id)).toEqual(['workflow', 'agent', 'where', 'limits']);
    expect(stepsForSurface('global', 'general').map((s) => s.id)).toEqual(['identity', 'access', 'chats', 'files']);
    expect(stepsForSurface('workspace', 'general').map((s) => s.id)).toEqual(['identity', 'chats', 'files']);
    expect(visibleSteps('prompts', new Set(['find'])).map((s) => s.id)).toEqual(['find']);
  });

  it('resolves the requested step', () => {
    const steps = TAB_STEPS.execution;
    expect(resolveStep(steps, 'limits')).toBe('limits');
    expect(resolveStep(steps, 'nope')).toBe('workflow');
  });

  it('round-trips tab and step through the URL', () => {
    const search = formatSettingsLocation('?x=1', 'execution', 'where');
    expect(search).toBe('?x=1&tab=execution&step=where');
    expect(parseSettingsLocation(search, TAB_IDS)).toEqual({ tab: 'execution', step: 'where' });
    expect(parseSettingsLocation('?tab=bogus', TAB_IDS)).toEqual({ tab: null, step: null });
  });
});

describe('settings route', () => {
  it('keeps tab and step through parse and serialize for global and Workspace settings', () => {
    const global = parseRoute('/settings', '?tab=execution&step=where');
    expect(global.settings).toEqual({ tab: 'execution', step: 'where' });
    expect(serializeRoute(global)).toBe('/settings?tab=execution&step=where');
    const workspace = parseRoute('/workspace/3/settings', '?tab=archive');
    expect(serializeRoute(workspace)).toBe('/workspace/3/settings?tab=archive');
    expect(serializeRoute(parseRoute('/tasks', '?tab=execution'))).toBe('/tasks');
  });
});

describe('settings step rail and Back/Next', () => {
  const mount = async (surface: 'global' | 'workspace', step: string | null, onStep: (s: string) => void) => {
    const config = makeConfig();
    const workspace = makeWorkspace();
    const channels = { list: [], onToggleEvent: () => {}, onCreated: () => {}, onDeleted: () => {} };
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
        intro: 'x',
        tabs: SETTING_TABS,
        tab: 'execution',
        onTab: () => {},
        step,
        onStep,
        ctx,
        dirty: false,
        saving: false,
        error: null,
        onSave: () => {},
        onDiscard: () => {},
      }),
    );
  };

  it('marks the active step with aria-current and renders only that step', async () => {
    const host = await mount('global', 'agent', () => {});
    const rail = host.querySelector('nav[aria-label="How a Ticket runs"]');
    const buttons = [...(rail?.querySelectorAll('button') ?? [])];
    expect(buttons.map((b) => b.getAttribute('aria-current'))).toEqual([null, 'step', null, null]);
    expect(host.querySelector('#settings-section-routing-labels')).not.toBeNull();
    expect(host.querySelector('#settings-section-workflow-labels')).toBeNull();
    expect(sectionsForStep('global', 'execution', 'agent').length).toBeGreaterThan(0);
  });

  it('lays the Agent step out as Routing Labels, Route Classifier with nested Model Options, then Default agent', async () => {
    const host = await mount('global', 'agent', () => {});
    const titles = [...host.querySelectorAll('section h2')].map((h) => h.textContent);
    expect(titles).toEqual(['2 · Routing Labels', '3 · Route Classifier', '4 · Default agent']);
    expect(host.querySelector('#settings-section-route-classifier')?.textContent).toContain('Model Options');
    expect(host.querySelector('#settings-section-model-options')).toBeNull();
    const rules = [...(host.querySelectorAll('ol[aria-label="Agent resolution order"] li') ?? [])].map((li) => li.querySelector('span')?.textContent);
    expect(rules).toEqual(['1st', '2nd', '3rd', 'Always matches']);
  });

  it('shows the resolution strip on the Workflow step and drops it elsewhere', async () => {
    const onWorkflow = await mount('global', null, () => {});
    expect(onWorkflow.querySelector('ol[aria-label="Workflow resolution order"]')).not.toBeNull();
    await cleanup();
    const elsewhere = await mount('global', 'limits', () => {});
    expect(elsewhere.querySelector('ol[aria-label="Workflow resolution order"]')).toBeNull();
  });

  it('steps with Next and Back, hiding Back on the first step and Next on the last', async () => {
    const seen: string[] = [];
    const first = await mount('global', null, (s) => seen.push(s));
    const labels = () => [...first.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels().some((l) => l?.startsWith('←'))).toBe(false);
    const next = [...first.querySelectorAll('button')].find((b) => b.textContent === 'Next: Which agent →');
    await act(async () => {
      next?.click();
    });
    expect(seen).toEqual(['agent']);
    await cleanup();
    const last = await mount('global', 'limits', () => {});
    const lastLabels = [...last.querySelectorAll('button')].map((b) => b.textContent);
    expect(lastLabels).toContain('← Where');
    expect(lastLabels.some((l) => l?.startsWith('Next:'))).toBe(false);
  });

  it('shows the scope chip, breadcrumb, step question and footer note from the mockup', async () => {
    const host = await mount('global', null, () => {});
    expect(host.textContent).toContain('Global');
    expect(host.textContent).toContain('Settings › Running Tickets › Workflow');
    expect(host.querySelector('h2')?.textContent).toBe('Which workflow runs?');
    expect(host.textContent).toContain('Edits apply from each Ticket’s next Retry.');
  });

  it('numbers the Global sections to match the strip, with one divider before the per-workflow cards', async () => {
    const host = await mount('global', null, () => {});
    const headings = [...host.querySelectorAll('section h2')].map((h) => h.textContent);
    expect(headings).toEqual(['2 · Workflow Labels', '3 · Workflow classifier Off', '5 · Global default workflow', 'Epics']);
    expect(host.textContent).toContain('Then, for the chosen workflow');
    expect(host.querySelector('#settings-section-global-default-workflow')).not.toBeNull();
    expect(host.querySelector('#settings-workflow')).not.toBeNull();
  });

  it('makes the Workspace default the editable card at Workspace scope, with variables and Epics under the divider', async () => {
    const host = await mount('workspace', null, () => {});
    const headings = [...host.querySelectorAll('section h2')].map((h) => h.textContent);
    expect(headings).toEqual(['2 · Workflow Labels', '3 · Workflow classifier', '4 · Workspace default workflow', 'Epics']);
    expect(host.querySelectorAll('[class*="tracking-wider"]').length).toBeGreaterThan(0);
    expect(host.textContent?.match(/Then, for the chosen workflow/g)).toHaveLength(1);
    expect(host.querySelector('#workspace-workflow')).not.toBeNull();
    expect(host.querySelector('[role="switch"][aria-label="Workflow classifier"]')).not.toBeNull();
    const strip = host.querySelector('ol[aria-label="Workflow resolution order"]');
    expect(strip?.textContent).toContain('Workspace default');
    expect(strip?.querySelector('a[href="#settings-section-workspace-default-workflow"]')).not.toBeNull();
  });

  it('keeps global-only steps off the Workspace surface', async () => {
    const host = await mount('workspace', null, () => {});
    const rail = host.querySelector('nav[aria-label="How a Ticket runs"]');
    expect(rail?.querySelectorAll('button').length).toBeGreaterThan(0);
  });
});

describe('ResolutionStrip', () => {
  it('borders the always-matching rule and dashes rules set elsewhere', async () => {
    const host = await mountComponent(
      createElement(ResolutionStrip, {
        label: 'Order',
        rules: [
          { caption: '1st', name: 'Elsewhere', note: 'n' },
          { caption: '2nd', name: 'Here', note: 'n', href: '#here' },
          { caption: 'Always matches', name: 'Fallback', note: 'n', always: true },
        ],
      }),
    );
    const items = [...host.querySelectorAll('li')];
    expect(items[0]?.className).toContain('border-dashed');
    expect(items[0]?.querySelector('a')).toBeNull();
    expect(items[1]?.querySelector('a')?.getAttribute('href')).toBe('#here');
    expect(items[2]?.className).toContain('border-accent');
  });
});

describe('Integrations Work step', () => {
  const mountWork = async (resolvedSource: 'configured' | 'detected' | 'code-repository') => {
    vi.spyOn(api, 'trackerKinds').mockResolvedValue({ kinds: [] });
    vi.spyOn(api, 'trackerDetection').mockResolvedValue({ detectedTracker: null, detectedCodeRepository: null, repoDocTriageLabels: {} });
    const config = makeConfig();
    const workspace = makeWorkspace({
      trackerEnabled: true,
      resolvedTracker: { ok: true, label: 'GitHub Issues', kind: 'github', source: resolvedSource, code: null, reason: null },
    });
    const ctx = {
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
        intro: 'x',
        tabs: SETTING_TABS,
        tab: 'integrations',
        onTab: () => {},
        step: 'work',
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

  it('highlights the tracker source that actually resolved', async () => {
    const host = await mountWork('detected');
    const items = [...host.querySelectorAll('ol[aria-label="Tracker resolution order"] li')];
    expect(items.map((li) => li.querySelector('span')?.textContent)).toEqual(['1st', '2nd · in use', '3rd']);
    expect(items[1]?.className).toContain('border-accent');
    expect(items[0]?.className).toContain('border-dashed');
    expect(host.querySelector('input[type=radio]')).not.toBeNull();
    expect(host.textContent).toContain('Triage labels');
  });
});
