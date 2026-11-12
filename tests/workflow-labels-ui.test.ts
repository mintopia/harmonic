// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../web/src/api.js';
import { GlobalDefaultWorkflow, WorkflowLabelOverlayEditor, WorkflowLabelsEditor, WorkspaceDefaultWorkflow } from '../web/src/components/WorkflowLabelsEditor.js';
import { Properties } from '../web/src/components/ticket/Metrics.js';
import type { AppConfig, WorkflowLabelOverlayEntry } from '../web/src/types.js';
import { cleanup, flush, makeConfig, makeTask, mountComponent } from './component-smoke-harness.js';

const library = [
  { name: 'Security review on label', description: '', subject: 'ticket' as const, version: 4, inUse: { tickets: 0, running: 0, workspaces: 0 }, assignedAs: [] },
  { name: 'Docs only', description: '', subject: 'ticket' as const, version: 2, inUse: { tickets: 0, running: 0, workspaces: 0 }, assignedAs: [] },
];
const base = makeConfig();
const config: AppConfig = {
  ...base,
  workflowLabels: [
    { label: 'security', workflow: 'Security review on label' },
    { label: 'docs', workflow: 'Docs only' },
  ],
};

let latestConfig: AppConfig = config;
let latestOverlay: WorkflowLabelOverlayEntry[] | null = null;
let latestWorkflow: string | null = null;
let latestStep: string | null = null;
const captureStep = (step: string) => {
  latestStep = step;
};
const captureConfig = (next: AppConfig) => {
  latestConfig = next;
};
const captureOverlay = (next: WorkflowLabelOverlayEntry[]) => {
  latestOverlay = next;
};
const captureWorkflow = (next: string | null) => {
  latestWorkflow = next;
};

function Global() {
  const [c, setC] = useState(config);
  return createElement(WorkflowLabelsEditor, { config: c, onChange: (next: AppConfig) => { captureConfig(next); setC(next); }, onStep: captureStep });
}

function GlobalDefault() {
  const [c, setC] = useState(config);
  return createElement(GlobalDefaultWorkflow, { config: c, onChange: (next: AppConfig) => { captureConfig(next); setC(next); } });
}

function WorkspaceDefault() {
  const [workflow, setWorkflow] = useState<string | null>(null);
  return createElement(WorkspaceDefaultWorkflow, {
    workflow,
    config: { ...config, defaults: { ...config.defaults, workflow: 'Docs only' } },
    onChange: (next: string | null) => { captureWorkflow(next); setWorkflow(next); },
  });
}

function Overlay({ initial }: { initial: WorkflowLabelOverlayEntry[] | null }) {
  const [overlay, setOverlay] = useState(initial);
  return createElement(WorkflowLabelOverlayEditor, {
    overlay,
    config: { ...config, defaults: { ...config.defaults, workflow: 'Docs only' } },
    onChange: (next: WorkflowLabelOverlayEntry[]) => { captureOverlay(next); setOverlay(next); },
  });
}

async function change(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    await flush();
  });
}
const click = async (el: Element | null) => {
  await act(async () => {
    (el as HTMLElement).click();
    await flush();
  });
};
const byLabel = <T extends HTMLElement>(host: HTMLElement, label: string) => host.querySelector<T>(`[aria-label="${label}"]`)!;

beforeEach(() => {
  vi.spyOn(api, 'workflows').mockResolvedValue({ workflows: library, total: library.length });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

describe('WorkflowLabelsEditor', () => {
  it('shows the rows and links the Routing Labels cross-reference to step 2', async () => {
    const host = await mountComponent(createElement(Global));
    expect(byLabel<HTMLInputElement>(host, 'Workflow Label 1').value).toBe('security');
    expect(byLabel<HTMLSelectElement>(host, 'Workflow for Workflow Label 2').value).toBe('Docs only');
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'step 2')!);
    expect(latestStep).toBe('agent');
  });

  it('adds, edits, reorders-by-data and removes rows', async () => {
    const host = await mountComponent(createElement(Global));
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === '+ Add Workflow Label')!);
    expect(latestConfig.workflowLabels).toHaveLength(3);
    await change(byLabel(host, 'Workflow Label 3'), 'ci');
    await change(byLabel(host, 'Workflow for Workflow Label 3'), 'Docs only');
    expect(latestConfig.workflowLabels[2]).toEqual({ label: 'ci', workflow: 'Docs only' });
    await click(byLabel(host, 'Remove Workflow Label 1'));
    expect(latestConfig.workflowLabels.map((l) => l.label)).toEqual(['docs', 'ci']);
  });

  it('sets and clears the global default workflow, listing versions and an editor link', async () => {
    const host = await mountComponent(createElement(GlobalDefault));
    const select = host.querySelector<HTMLSelectElement>('#settings-workflow')!;
    expect([...select.options].map((o) => o.textContent)).toContain('Docs only · v2');
    expect(host.querySelector('a[href="/workflows"]')?.textContent).toBe('Open in editor');
    await change(host.querySelector('#settings-workflow')!, 'Docs only');
    expect(latestConfig.defaults.workflow).toBe('Docs only');
    await change(host.querySelector('#settings-workflow')!, '');
    expect(latestConfig.defaults.workflow).toBeNull();
  });

  it('flags a duplicate label on its row', async () => {
    const host = await mountComponent(createElement(Global));
    await change(byLabel(host, 'Workflow Label 2'), 'SECURITY');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('SECURITY');
  });
});

describe('WorkflowLabelOverlayEditor', () => {
  it('lists inherited globals with a Global chip and toggles them off', async () => {
    const host = await mountComponent(createElement(Overlay, { initial: null }));
    expect(host.textContent).toContain('Security review on label');
    expect(host.textContent).toContain('Global');
    await click(byLabel(host, 'Disable workflow label 2'));
    expect(latestOverlay?.[1]).toEqual({ kind: 'global', ref: 'docs', enabled: false });
  });

  it('flags a local row that shadows an enabled global, and clears it when the global is disabled', async () => {
    const host = await mountComponent(createElement(Overlay, { initial: null }));
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === '+ Add Workflow Label')!);
    await change(byLabel(host, 'Workflow Label 3'), 'Security');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('duplicates the enabled Global label');
    await click(byLabel(host, 'Disable workflow label 1'));
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('offers inherit plus the Library for the Workspace default workflow', async () => {
    const host = await mountComponent(createElement(WorkspaceDefault));
    const select = host.querySelector<HTMLSelectElement>('#workspace-workflow')!;
    expect(select.options[0]?.textContent).toBe('Use global default · Docs only');
    await change(select, 'Security review on label');
    expect(latestWorkflow).toBe('Security review on label');
    await change(select, '');
    expect(latestWorkflow).toBeNull();
  });
});

describe('Ticket Workflow fact', () => {
  const text = async (props: Parameters<typeof makeTask>[0], latestVersion?: number | null) => {
    const host = await mountComponent(createElement(Properties, { task: makeTask(props), allTasks: [], workspaceName: 'ws', latestVersion }));
    return host.textContent?.replace(/\s+/g, ' ') ?? '';
  };

  it('names the Workflow Label that chose it, with the snapshot note', async () => {
    expect(await text({ workflowRef: 'Security review on label@4', workflowChosen: 'label', workflowLabel: 'security' }, 5)).toContain(
      'WorkflowSecurity review on label v4 — chosen by Workflow Label securitySnapshotted v4; v5 exists and applies from the next Retry.',
    );
  });

  it('reads operator choice, Workspace default and global default', async () => {
    expect(await text({ workflowRef: 'Docs only@2', workflowChosen: 'explicit' })).toContain('Docs only v2 — operator choice on this Ticket');
    expect(await text({ workflowRef: 'Migrated (harmonic)@1', workflowChosen: 'workspace' })).toContain('Migrated (harmonic) v1 — Workspace default');
    expect(await text({ workflowRef: 'Migrated (global)@2', workflowChosen: 'global' }, 2)).toMatch(/Migrated \(global\) v2 — global default$/);
  });
});
