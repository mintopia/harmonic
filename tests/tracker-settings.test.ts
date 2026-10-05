// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../web/src/api.js';
import { CodeRepositorySection, IssueTrackerSection, TriageLabelsSection } from '../web/src/components/TrackerSettings.js';
import type { WorkspaceRenderCtx } from '../web/src/components/settings-schema.js';
import type { TrackerKindInfo, VerifyResult, Workspace } from '../web/src/types.js';
import { cleanup, flush, makeConfig, makeWorkspace, mountComponent } from './component-smoke-harness.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

const kinds: TrackerKindInfo[] = [
  { id: 'github', label: 'GitHub', secretNames: [], settingsSchema: { type: 'object', properties: {} }, capabilities: {} },
  {
    id: 'forgejo',
    label: 'Forgejo',
    secretNames: ['forgejoToken'],
    settingsSchema: {
      type: 'object',
      properties: { host: { type: 'string', title: 'Host' }, authMode: { type: 'string', enum: ['token', 'basic'] } },
      required: ['host'],
    },
    capabilities: {},
  },
  {
    id: 'jira',
    label: 'Jira',
    secretNames: ['JIRA_TOKEN'],
    settingsSchema: { type: 'object', properties: { baseUrl: { type: 'string', title: 'Base URL' } }, required: ['baseUrl'] },
    capabilities: {},
  },
];

function stubApi(opts: { secretSet?: boolean; verify?: VerifyResult } = {}) {
  vi.spyOn(api, 'trackerKinds').mockResolvedValue({ kinds });
  vi.spyOn(api, 'trackerDetection').mockResolvedValue({
    detectedTracker: { name: 'GitHub', kind: 'github' },
    detectedCodeRepository: 'github',
  });
  vi.spyOn(api, 'secretStatus').mockResolvedValue({ name: 'forgejoToken', set: opts.secretSet ?? false });
  vi.spyOn(api, 'verifyTracker').mockResolvedValue(opts.verify ?? { ok: true, identity: 'octocat' });
  vi.spyOn(api, 'verifyRepository').mockResolvedValue(opts.verify ?? { ok: true, identity: 'octocat' });
  return {
    setSecret: vi.spyOn(api, 'setSecret').mockResolvedValue(null),
    clearSecret: vi.spyOn(api, 'clearSecret').mockResolvedValue(null),
  };
}

const seen: { latest: Workspace | null } = { latest: null };

function Harness({ initial, Section, onChange = (w) => { seen.latest = w; } }: { initial: Workspace; Section: typeof IssueTrackerSection; onChange?: (w: Workspace) => void }) {
  const [workspace, setWorkspaceState] = useState(initial);
  const setWorkspace = (next: Workspace) => {
    onChange(next);
    setWorkspaceState(next);
  };
  const ctx: WorkspaceRenderCtx = {
    surface: 'workspace',
    config: makeConfig(),
    workspace,
    pristineWorkspace: initial,
    setWorkspace,
    errors: {},
    blockedByRunningTask: false,
    onRequestDelete: () => {},
  };
  return createElement(Section, { ctx });
}

const forgejo = () =>
  makeWorkspace({
    id: 3,
    trackerEnabled: true,
    configuredTracker: { kind: 'forgejo', settings: { host: 'https://git.example.com' } },
    resolvedTracker: { ok: true, label: 'Forgejo', kind: 'forgejo', source: 'configured', code: null, reason: null },
  });

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found as HTMLButtonElement;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
    await flush();
  });
}

describe('Issue tracker section', () => {
  it('inherit: no kind settings, shows the detected declaration', async () => {
    stubApi();
    const host = await mountComponent(createElement(Harness, { initial: makeWorkspace({ id: 3 }), Section: IssueTrackerSection }));
    const select = host.querySelector<HTMLSelectElement>('#workspace-tracker-kind')!;
    expect(select.value).toBe('');
    expect(select.textContent).toContain('Inherit (automatic)');
    expect(host.textContent).toContain('Inherited: the repo declares GitHub');
    expect(host.querySelector('#workspace-tracker-setting-host')).toBeNull();
  });

  it('a kind selected renders its schema fields and resolved source', async () => {
    stubApi();
    const host = await mountComponent(createElement(Harness, { initial: forgejo(), Section: IssueTrackerSection }));
    expect(host.querySelector<HTMLInputElement>('#workspace-tracker-setting-host')!.value).toBe('https://git.example.com');
    expect(host.querySelector('#workspace-tracker-setting-authMode')).not.toBeNull();
    expect(host.textContent).toContain('Resolved: Forgejo via Configured');
  });

  it('warns, without blocking, when a tracker base URL is not HTTPS', async () => {
    stubApi();
    const jira = (baseUrl: string) =>
      makeWorkspace({ id: 3, trackerEnabled: true, configuredTracker: { kind: 'jira', settings: { baseUrl } } });
    const insecure = await mountComponent(createElement(Harness, { initial: jira('http://jira.internal'), Section: IssueTrackerSection }));
    expect(insecure.querySelector('[role=alert]')?.textContent).toContain('not HTTPS');
    await cleanup();
    const secure = await mountComponent(createElement(Harness, { initial: jira('https://jira.example.com'), Section: IssueTrackerSection }));
    expect(secure.querySelector('[role=alert]')).toBeNull();
  });

  it('selecting Inherit clears the Configured Tracker', async () => {
    stubApi();
    const host = await mountComponent(createElement(Harness, { initial: forgejo(), Section: IssueTrackerSection }));
    const select = host.querySelector<HTMLSelectElement>('#workspace-tracker-kind')!;
    await act(async () => {
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(seen.latest?.configuredTracker).toBeNull();
  });

  it('secret not set offers Set only; the value is never shown', async () => {
    const spies = stubApi({ secretSet: false });
    const host = await mountComponent(createElement(Harness, { initial: forgejo(), Section: IssueTrackerSection }));
    expect(host.textContent).toContain('Not set');
    expect(() => button(host, 'Clear forgejoToken')).toThrow();
    await click(button(host, 'Set'));
    const input = host.querySelector<HTMLInputElement>('input[type=password]')!;
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 's3cret');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button(host, 'Save'));
    expect(spies.setSecret).toHaveBeenCalledWith(3, 'forgejoToken', 's3cret');
  });

  it('secret set offers Replace and Clear', async () => {
    const spies = stubApi({ secretSet: true });
    const host = await mountComponent(createElement(Harness, { initial: forgejo(), Section: IssueTrackerSection }));
    expect(host.textContent).toContain('Set');
    expect(() => button(host, 'Replace')).not.toThrow();
    await click(button(host, 'Clear forgejoToken'));
    expect(spies.clearSecret).toHaveBeenCalledWith(3, 'forgejoToken');
  });

  it('verify success shows the identity', async () => {
    stubApi({ verify: { ok: true, identity: 'octocat' } });
    const host = await mountComponent(createElement(Harness, { initial: forgejo(), Section: IssueTrackerSection }));
    await click(button(host, 'Verify tracker'));
    expect(host.textContent).toContain('Verified as octocat');
  });

  it('verify failure shows the error', async () => {
    stubApi({ verify: { ok: false, reason: '401 bad credentials' } });
    const host = await mountComponent(createElement(Harness, { initial: forgejo(), Section: IssueTrackerSection }));
    await click(button(host, 'Verify tracker'));
    expect(host.textContent).toContain('401 bad credentials');
  });
});

describe('Code repository section', () => {
  it('shows the detected forge and verifies', async () => {
    stubApi();
    const host = await mountComponent(createElement(Harness, { initial: makeWorkspace({ id: 3 }), Section: CodeRepositorySection }));
    expect(host.textContent).toContain('GitHub');
    expect(host.querySelector<HTMLSelectElement>('#workspace-code-repository')!.value).toBe('');
    await click(button(host, 'Verify repository'));
    expect(host.textContent).toContain('Reachable on octocat');
    expect(host.textContent).not.toContain('FORGEJO_TOKEN');
  });

  it('offers the FORGEJO_TOKEN Secret when the Code Repository is Forgejo and no Forgejo tracker supplies one', async () => {
    stubApi();
    const host = await mountComponent(createElement(Harness, { initial: makeWorkspace({ id: 3, codeRepository: 'forgejo' }), Section: CodeRepositorySection }));
    expect(host.textContent).toContain('FORGEJO_TOKEN');
    const withTracker = await mountComponent(
      createElement(Harness, { initial: makeWorkspace({ id: 4, codeRepository: 'forgejo', configuredTracker: { kind: 'forgejo' } }), Section: CodeRepositorySection }),
    );
    expect(withTracker.textContent).not.toContain('FORGEJO_TOKEN');
  });
});

describe('tracker detection sharing', () => {
  it('fetches detection once when both sections mount together', async () => {
    stubApi();
    const host = await mountComponent(
      createElement(
        'div',
        null,
        createElement(Harness, { initial: makeWorkspace({ id: 3 }), Section: IssueTrackerSection }),
        createElement(Harness, { initial: makeWorkspace({ id: 3 }), Section: CodeRepositorySection }),
      ),
    );
    expect(host.textContent).toContain('GitHub');
    expect(vi.mocked(api.trackerDetection)).toHaveBeenCalledTimes(1);
  });
});

describe('Triage labels section', () => {
  it('uses the defaults as placeholders and inherits when empty', async () => {
    stubApi();
    const host = await mountComponent(createElement(Harness, { initial: makeWorkspace({ id: 3 }), Section: TriageLabelsSection }));
    const input = host.querySelector<HTMLInputElement>('#workspace-triage-wayfinderMap')!;
    expect(input.placeholder).toBe('wayfinder:map');
    expect(input.value).toBe('');
    expect(seen.latest?.triageLabels).toBeNull();
  });
});
