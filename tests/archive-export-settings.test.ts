// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../web/src/api.js';
import { SettingsForm } from '../web/src/components/SettingsForm.js';
import type { RenderCtx } from '../web/src/components/settings-schema.js';
import { firstPatternError, normalizeConfigExport, normalizeWorkspaceExport } from '../web/src/archive-export-model.js';
import { SETTING_TABS, workspaceTabs } from '../src/domain/settings-registry.js';
import type { AppConfig, Workspace } from '../web/src/types.js';
import { cleanup, makeConfig, makeWorkspace, mountComponent } from './component-smoke-harness.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

const SECRET = 'AKIA-super-secret-value';
const MASK = '********';

function s3Config(over: Partial<AppConfig['export']['s3']> = {}): AppConfig {
  const base = makeConfig();
  return {
    ...base,
    export: {
      ...base.export,
      directory: { path: '/srv/exports' },
      s3: { ...base.export.s3, bucket: 'acme', region: 'eu-west-2', accessKeyId: MASK, secretAccessKey: MASK, ...over },
    },
  };
}

function GlobalHarness({ initial, onCtx }: { initial: AppConfig; onCtx?: (c: AppConfig) => void }) {
  const [config, setConfig] = useState(initial);
  const [pristine] = useState(initial);
  onCtx?.(config);
  const ctx: RenderCtx = {
    surface: 'global',
    config,
    baseline: makeConfig(),
    setConfig,
    errors: {},
    harnessPermissionModes: {},
    channels: { list: [], onToggleEvent: () => {}, onCreated: () => {}, onDeleted: () => {} },
  };
  return createElement(SettingsForm, {
    title: 'Settings',
    intro: '',
    tabs: SETTING_TABS,
    tab: 'archive',
    onTab: () => {},
    ctx,
    dirty: JSON.stringify(config) !== JSON.stringify(pristine),
    saving: false,
    error: null,
    onSave: () => {},
    onDiscard: () => {},
  });
}

function WorkspaceHarness({ config, initial, onWs }: { config: AppConfig; initial: Workspace; onWs?: (w: Workspace) => void }) {
  const [ws, setWs] = useState(initial);
  onWs?.(ws);
  const ctx: RenderCtx = {
    surface: 'workspace',
    config,
    workspace: ws,
    pristineWorkspace: initial,
    setWorkspace: setWs,
    errors: {},
    blockedByRunningTask: false,
    onRequestDelete: () => {},
  };
  return createElement(SettingsForm, {
    title: 'Workspace',
    intro: '',
    tabs: workspaceTabs(),
    tab: 'archive',
    onTab: () => {},
    ctx,
    dirty: JSON.stringify(ws) !== JSON.stringify(initial),
    saving: false,
    error: null,
    onSave: () => {},
    onDiscard: () => {},
  });
}

const click = (el: Element | null | undefined) => act(async () => void el?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

async function type(input: HTMLInputElement | null, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const byLabel = (host: HTMLElement, label: string) => host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

describe('Archive & Export tab', () => {
  it('appears last in the global tab strip and in Workspace scope', async () => {
    expect(SETTING_TABS.at(-1)).toEqual({ id: 'archive', label: 'Archive & Export' });
    expect(workspaceTabs().map((t) => t.id)).toContain('archive');
    const host = await mountComponent(createElement(WorkspaceHarness, { config: makeConfig(), initial: makeWorkspace() }));
    expect(host.textContent).toContain('Archive & Export');
    expect(host.textContent).toContain('Export Destinations');
    expect(host.textContent).toContain('Archive retention');
    expect(host.textContent).toContain('Forever');
    expect(host.textContent).toContain('Inherited from global default');
    const sw = host.querySelector<HTMLButtonElement>('[aria-label="Override Keep for (days)"]');
    expect(sw?.disabled).toBe(false);
  });

  it('overrides retention and dispositions per Workspace', async () => {
    let latest: Workspace | undefined;
    const host = await mountComponent(createElement(WorkspaceHarness, { config: makeConfig(), initial: makeWorkspace(), onWs: (w) => (latest = w) }));
    await click(host.querySelector('[aria-label="Override Keep for (days)"]'));
    expect(latest?.archiveRetentionDays).toBe(90);
    await type(host.querySelector<HTMLInputElement>('#archive-retain-days'), '14');
    expect(latest?.archiveRetentionDays).toBe(14);
    await click(host.querySelector('[aria-label="Override Max total size (MB)"]'));
    expect(latest?.archiveRetentionMaxTotalMB).toBe(1024);
    await click(host.querySelector('[aria-label="Override Dispositions to export"]'));
    expect(latest?.exportIncludeStates).toEqual(['done', 'cancelled', 'deleted']);
    await click([...host.querySelectorAll('[aria-label="Dispositions to export"] button')].find((b) => b.textContent?.trim() === 'deleted'));
    expect(latest?.exportIncludeStates).toEqual(['done', 'cancelled']);
    await click(host.querySelector('[aria-label="Override Dispositions to export"]'));
    expect(latest?.exportIncludeStates).toBeNull();
  });

  it('shows inherited Workspace values as the global value with the Inherited note', async () => {
    const config = s3Config();
    config.export.enabled = true;
    const host = await mountComponent(createElement(WorkspaceHarness, { config, initial: makeWorkspace() }));
    const sw = host.querySelector('[aria-label="Override Export on terminal disposition"]');
    expect(sw?.getAttribute('aria-checked')).toBe('false');
    const field = sw!.closest('div')!.parentElement!;
    expect(field.textContent).toContain('On');
    expect(field.textContent).toContain('Inherited from global default');
    expect(host.querySelector('#export-s3-bucket')).toBeNull();
    expect(host.textContent).toContain('acme');
  });

  it('overriding via the switch reveals the control, notes it, and Reset to default inherits again', async () => {
    let ws: Workspace | null = null;
    const host = await mountComponent(createElement(WorkspaceHarness, { config: s3Config(), initial: makeWorkspace(), onWs: (w) => (ws = w) }));
    await click(host.querySelector('[aria-label="Override Bucket"]'));
    expect(ws!.exportS3Bucket).toBe('acme');
    expect(host.querySelector<HTMLInputElement>('#export-s3-bucket')?.value).toBe('acme');
    expect(host.textContent).toContain('Overridden here');
    expect(host.textContent).toContain('Modified');
    await click(button(host, 'Reset to default'));
    expect(ws!.exportS3Bucket).toBeNull();
    expect(host.querySelector('#export-s3-bucket')).toBeNull();
    await click(host.querySelector('[aria-label="Override Bucket"]'));
    await click(host.querySelector('[aria-label="Override Bucket"]'));
    expect(ws!.exportS3Bucket).toBeNull();
  });

  it('uses destination header switches in Workspace scope', async () => {
    const host = await mountComponent(createElement(WorkspaceHarness, { config: makeConfig(), initial: makeWorkspace() }));
    expect(host.querySelector('[aria-label="Enable Directory Destination"]')).not.toBeNull();
    expect(host.textContent).not.toMatch(/\bOff\b.*Enabled/);
  });

  it('renders retention, export, destinations and redaction cards globally', async () => {
    const host = await mountComponent(createElement(GlobalHarness, { initial: makeConfig() }));
    for (const title of ['Archive retention', 'Export', 'Export Destinations', 'Redaction patterns']) expect(host.textContent).toContain(title);
    expect(host.querySelectorAll('[aria-label="Baseline redaction patterns"] li')).toHaveLength(6);
  });

  it('marks a changed retention field Modified and reverts it', async () => {
    const host = await mountComponent(createElement(GlobalHarness, { initial: makeConfig() }));
    const days = host.querySelector<HTMLInputElement>('#archive-retain-days');
    expect(host.textContent).not.toContain('Modified');
    await type(days, '30');
    expect(host.textContent).toContain('Modified');
    await click(button(host, 'Revert'));
    expect(host.querySelector<HTMLInputElement>('#archive-retain-days')!.value).toBe('');
    expect(host.textContent).not.toContain('Modified');
  });

  it('never renders stored credentials and supports Replace', async () => {
    let seen: AppConfig | null = null;
    const host = await mountComponent(createElement(GlobalHarness, { initial: s3Config(), onCtx: (c) => (seen = c) }));
    expect(host.innerHTML).not.toContain(SECRET);
    const masked = byLabel(host, 'Secret access key (masked, stored)');
    expect(masked?.disabled).toBe(true);
    await click([...host.querySelectorAll('button')].filter((b) => b.textContent === 'Replace')[1]);
    const input = host.querySelector<HTMLInputElement>('#export-s3-sk')!;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    expect(input.value).toBe('');
    await type(input, SECRET);
    expect(seen!.export.s3.secretAccessKey).toBe(SECRET);
    expect(seen!.export.s3.accessKeyId).toBe(MASK);
    await click(button(host, 'Cancel'));
    expect(seen!.export.s3.secretAccessKey).toBe(MASK);
    expect(byLabel(host, 'Secret access key (masked, stored)')).not.toBeNull();
  });

  it('shows a workspace-inherited credential masked, and overriding it is Modified', async () => {
    const host = await mountComponent(createElement(WorkspaceHarness, { config: s3Config(), initial: makeWorkspace() }));
    expect(host.innerHTML).not.toContain(SECRET);
    expect(host.textContent).toContain('(set)');
    expect(host.textContent).not.toContain('Modified');
    await click(host.querySelector('[aria-label="Override Access key ID"]'));
    expect(host.textContent).toContain('Modified');
    expect(host.querySelector<HTMLInputElement>('#export-s3-ak')?.type).toBe('password');
  });

  it('runs Test Destination and shows the success row', async () => {
    const spy = vi.spyOn(api, 'testExportDestination').mockResolvedValue({ destination: 'directory', ok: true, testedAt: new Date().toISOString() });
    const host = await mountComponent(createElement(GlobalHarness, { initial: s3Config() }));
    const tests = [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Test Destination');
    expect(tests).toHaveLength(2);
    await click(tests[0]);
    expect(spy).toHaveBeenCalledWith({ workspaceId: null, destination: 'directory' });
    const status = host.querySelector('[role="status"]');
    expect(status?.textContent).toContain('Wrote and removed probe object');
    expect(status?.textContent).toContain('just now');
  });

  it('tests an inherited Workspace directory with a clean form and shows the ok row', async () => {
    const spy = vi.spyOn(api, 'testExportDestination').mockResolvedValue({ destination: 'directory', ok: true, testedAt: new Date().toISOString() });
    const host = await mountComponent(createElement(WorkspaceHarness, { config: s3Config({ bucket: null }), initial: makeWorkspace({ id: 3 }) }));
    const tests = [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Test Destination');
    expect(tests[0]!.disabled).toBe(false);
    expect(tests[1]!.disabled).toBe(true);
    await click(tests[0]);
    expect(spy).toHaveBeenCalledWith({ workspaceId: 3, destination: 'directory' });
    expect(host.querySelector('footer [role="status"]')?.textContent).toContain('Wrote and removed probe object');
  });

  it('shows the failure row with role=alert and passes the Workspace id', async () => {
    const spy = vi
      .spyOn(api, 'testExportDestination')
      .mockResolvedValue({ destination: 's3', ok: false, error: 'AccessDenied: s3:PutObject on acme', testedAt: new Date(Date.now() - 120_000).toISOString() });
    const host = await mountComponent(createElement(WorkspaceHarness, { config: s3Config(), initial: makeWorkspace({ id: 7 }) }));
    await click([...host.querySelectorAll('button')].filter((b) => b.textContent === 'Test Destination')[1]);
    expect(spy).toHaveBeenCalledWith({ workspaceId: 7, destination: 's3' });
    const alert = host.querySelector('footer [role="alert"]');
    expect(alert?.textContent).toContain('AccessDenied:');
    expect(alert?.textContent).toContain('s3:PutObject on acme');
    expect(alert?.textContent).toContain('2 min ago');
  });

  it('shows a request failure as an error row', async () => {
    vi.spyOn(api, 'testExportDestination').mockRejectedValue(new Error('network down'));
    const host = await mountComponent(createElement(GlobalHarness, { initial: s3Config() }));
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Test Destination'));
    expect(host.querySelector('footer [role="alert"]')?.textContent).toContain('network down');
  });

  it('disables Test Destination while there are unsaved edits', async () => {
    const host = await mountComponent(createElement(GlobalHarness, { initial: s3Config() }));
    const test = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Test Destination')!;
    expect(test().disabled).toBe(false);
    await type(host.querySelector<HTMLInputElement>('#export-dir-path'), '/other');
    expect(test().disabled).toBe(true);
    expect(test().title).toBe('Save changes to test them');
    expect(host.textContent).toContain('Uses the effective settings above.');
  });

  it('adds, validates and removes global redaction patterns', async () => {
    let seen: AppConfig | null = null;
    const host = await mountComponent(createElement(GlobalHarness, { initial: makeConfig(), onCtx: (c) => (seen = c) }));
    await click(button(host, '+ Add pattern'));
    await type(byLabel(host, 'Pattern id 1'), 'acme-id');
    await type(byLabel(host, 'Regular expression 1'), 'ACME-[0-9]{8}');
    expect(seen!.export.redact.patterns).toEqual([{ id: 'acme-id', regex: 'ACME-[0-9]{8}' }]);
    expect(host.querySelector('[data-pattern-error]')).toBeNull();

    await type(byLabel(host, 'Regular expression 1'), '([unclosed');
    expect(host.querySelectorAll('[data-pattern-error]')).toHaveLength(1);
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(0);
    await type(byLabel(host, 'Pattern id 1'), 'Bad Id');
    expect(host.querySelector('[data-pattern-error]')?.textContent).toContain('lowercase');

    await click(byLabel(host, 'Remove pattern 1'));
    expect(seen!.export.redact.patterns).toEqual([]);
  });

  it('shows global patterns read-only with a global chip in Workspace scope and stores Workspace additions', async () => {
    const config = makeConfig();
    config.export.redact.patterns = [{ id: 'internal-host', regex: 'corp\\.example' }];
    let ws: Workspace | null = null;
    const host = await mountComponent(createElement(WorkspaceHarness, { config, initial: makeWorkspace(), onWs: (w) => (ws = w) }));
    const globals = host.querySelector('[aria-label="Global redaction patterns"]');
    expect(globals?.textContent).toContain('internal-host');
    expect(globals?.textContent).toContain('global');
    expect(globals?.querySelector('input')).toBeNull();
    await click(button(host, '+ Add pattern'));
    expect(byLabel(host, 'Pattern id 2')).not.toBeNull();
    await type(byLabel(host, 'Pattern id 2'), 'acme');
    await type(byLabel(host, 'Regular expression 2'), 'ACME-\\d+');
    expect(ws!.exportRedactPatterns).toEqual([{ id: 'acme', regex: 'ACME-\\d+' }]);
  });
});

describe('archive-export-model', () => {
  it('blocks save on an invalid regex or id', () => {
    expect(firstPatternError([{ id: 'ok', regex: 'a+' }])).toBeNull();
    expect(firstPatternError([{ id: 'ok', regex: '(' }])).toContain('pattern 1');
    expect(firstPatternError([{ id: 'Bad', regex: 'a' }])).toContain('lowercase');
    expect(firstPatternError([{ id: 'a', regex: 'x' }, { id: 'a', regex: 'y' }])).toContain('unique');
  });

  it('turns blank strings into null before save, keeping the credential mask', () => {
    const c = s3Config({ endpoint: '', region: '' });
    c.export.directory.path = '';
    const out = normalizeConfigExport(c);
    expect(out.export.directory.path).toBeNull();
    expect(out.export.s3.endpoint).toBeNull();
    expect(out.export.s3.region).toBeNull();
    expect(out.export.s3.secretAccessKey).toBe(MASK);
    const w = normalizeWorkspaceExport(makeWorkspace({ exportS3Bucket: '', exportRedactPatterns: [] }));
    expect(w.exportS3Bucket).toBeNull();
    expect(w.exportRedactPatterns).toBeNull();
  });
});
