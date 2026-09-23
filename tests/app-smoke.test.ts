// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../web/src/App.js';
import type { AppConfig, Conversation, UpdateState, Workspace } from '../web/src/types.js';

class IdleWebSocket {
  static OPEN = 1;
  static latest: IdleWebSocket | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(_url: string) {
    IdleWebSocket.latest = this;
  }

  close() {}

  emit(message: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
}

function makeConfig(): AppConfig {
  return {
    name: '',
    harnesses: {
      claude: {
        command: 'claude',
        args: [],
        env: {},
        models: [{ id: 'claude-sonnet-4-6' }],
        defaultModel: 'claude-sonnet-4-6',
        cacheWarmSeconds: 300,
      },
    },
    defaults: { harness: 'claude', isolationMode: 'direct', priority: 'normal', conflictResolveTurns: 2 },
    chat: { harness: 'claude', model: 'claude-sonnet-4-6' },
    autoRunner: { enabled: false, maxConcurrentAttempts: 2 },
    verify: { task: { preMerge: { commands: [], critics: [] }, postMerge: { commands: [], critics: [] } }, epic: { preMerge: { commands: [], critics: [] }, resolvePrompt: 'Resolve failures.' } },
    guardrails: { budget: { wallClockMinutes: 60, tokens: null, costUsd: null }, progress: false, toolTimeoutMinutes: 10 },
    drive: { prompt: '', unattendedReminder: '', continuePrompt: '', mergeFate: 'auto-merge', continueAttempts: 0 },
    maxAttempts: 3,
    contextReuseTokenLimit: 100_000,
    editor: { maxFileSizeBytes: 2_097_152 },
    taskPrompt: '',
  };
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 1,
    name: 'Workspace One',
    workingDir: '/tmp/ws1',
    color: '#FA6152',
    trackerEnabled: false,
    trackerPollIntervalSeconds: 60,
    resolvedTracker: null,
    harness: null,
    model: null,
    chatHarness: null,
    chatModel: null,
    isolationMode: null,
    priority: null,
    conflictResolveTurns: null,
    maxConcurrentAttempts: null,
    autoRunnerEnabled: null,
    maxAttempts: null,
    contextReuseTokenLimit: null,
    taskPreMergeCommands: null,
    taskPreMergeCritics: null,
    taskPostMergeCommands: null,
    taskPostMergeCritics: null,
    epicPreMergeCommands: null,
    epicPreMergeCritics: null,
    guardrailBudget: null,
    guardrailProgress: null,
    toolTimeoutMinutes: null,
    drivePrompt: null,
    driveUnattendedReminder: null,
    driveContinuePrompt: null,
    driveMergeFate: null,
    driveContinueAttempts: null,
    taskPrompt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
    excludedDirectories: overrides.excludedDirectories ?? [],
  };
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 12,
    title: 'Fix the deployment',
    workspaceId: 1,
    harness: 'claude',
    model: 'claude-sonnet-4-6',
    workingDir: '/tmp/ws1',
    permissionMode: 'ask',
    state: 'active',
    sessionId: 'session-12',
    createdAt: 0,
    updatedAt: 0,
    endedAt: null,
    usage: null,
    cost: null,
    contextTokens: null,
    contextWindow: null,
    cacheWarmSeconds: null,
    ...overrides,
  };
}

function stubFetch(opts: {
  authenticated: boolean;
  passwordConfigured: boolean;
  workspaces?: Workspace[];
  conversation?: Conversation;
  update?: Omit<UpdateState, 'currentVersion'>;
  updateResponses?: Array<Omit<UpdateState, 'currentVersion'> | 'offline'>;
}) {
  const workspaces = opts.workspaces ?? [];
  let update = opts.update ?? { availableVersion: null, armedVersion: null, upgradingVersion: null, dismissedVersion: null, migrationRequired: false, mode: { kind: 'systemd' as const }, guardMissing: false, failed: null, idle: { runningAttempts: 0, mergingOrIntegrating: false, conversationMidTurn: false } };
  const updateResponses = opts.updateResponses ? [...opts.updateResponses] : null;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input instanceof Request ? input.url : input);
    if (path === '/api/auth/me') {
      return new Response(JSON.stringify({ authenticated: opts.authenticated, passwordConfigured: opts.passwordConfigured }));
    }
    if (path === '/api/config') return new Response(JSON.stringify(makeConfig()));
    if (path === '/api/update') {
      const next = updateResponses?.shift();
      if (next === 'offline') return new Response(JSON.stringify({ error: { message: 'restarting' } }), { status: 503 });
      if (next !== undefined) update = next;
      return new Response(JSON.stringify(update));
    }
    if (path === '/api/update/arm' && init?.method === 'DELETE') {
      update = { ...update, armedVersion: null };
      return new Response(JSON.stringify(update));
    }
    if (path === '/api/update/arm') {
      update = { ...update, armedVersion: update.availableVersion };
      return new Response(JSON.stringify(update));
    }
    if (path === '/api/update/dismiss') {
      update = { ...update, dismissedVersion: update.availableVersion };
      return new Response(JSON.stringify(update));
    }
    if (path === '/api/workspaces') return new Response(JSON.stringify({ workspaces, total: workspaces.length }));
    if (path.startsWith('/api/conversations?')) {
      const conversations = opts.conversation ? [opts.conversation] : [];
      return new Response(JSON.stringify({ conversations, total: conversations.length }));
    }
    const conversationId = path.match(/^\/api\/conversations\/(\d+)$/)?.[1];
    if (conversationId) {
      const id = Number(conversationId);
      return new Response(JSON.stringify(opts.conversation?.id === id ? opts.conversation : makeConversation({ id })));
    }
    if (/^\/api\/conversations\/\d+\/events$/.test(path)) return new Response(JSON.stringify({ events: [] }));
    if (path.startsWith('/api/tasks')) return new Response(JSON.stringify({ tasks: [], total: 0 }));
    if (path.includes('/epics')) return new Response(JSON.stringify({ epics: [], total: 0 }));
    if (path.startsWith('/api/activity')) return new Response(JSON.stringify({ processes: [], total: 0 }));
    if (path.startsWith('/api/stats')) return new Response(JSON.stringify({ cost: null }));
    return new Response(JSON.stringify({}));
  });
}

function stubMatchMedia() {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: true,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} });
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderApp(opts: {
  authenticated: boolean;
  passwordConfigured: boolean;
  workspaces?: Workspace[];
  conversation?: Conversation;
  update?: Omit<UpdateState, 'currentVersion'>;
  updateResponses?: Array<Omit<UpdateState, 'currentVersion'> | 'offline'>;
}) {
  stubMatchMedia();
  vi.stubGlobal('WebSocket', IdleWebSocket);
  stubFetch(opts);
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(App));
  });
  await flush();
  return host;
}

describe('App smoke (issue #452)', () => {
  it('shows an epic merge toast from the live event stream', async () => {
    const el = await renderApp({
      authenticated: true,
      passwordConfigured: true,
      workspaces: [makeWorkspace()],
    });

    await act(async () => {
      IdleWebSocket.latest?.emit({ type: 'epic_integrated', workspaceId: 1, epicRef: 5 });
    });
    await flush();

    expect(el.textContent).toContain('Epic #5 merged');
  });

  it('shows the available update banner and dismisses that version', async () => {
    const el = await renderApp({
      authenticated: true,
      passwordConfigured: true,
      workspaces: [makeWorkspace()],
      update: { availableVersion: '2.7.0', armedVersion: null, upgradingVersion: null, dismissedVersion: null, migrationRequired: false, mode: { kind: 'systemd' as const }, guardMissing: false, failed: null, idle: { runningAttempts: 0, mergingOrIntegrating: false, conversationMidTurn: false } },
    });

    expect(el.textContent).toContain('Version 2.7.0 is available');
    const dismiss = [...el.querySelectorAll('button')].find((button) => button.textContent === 'Dismiss');
    expect(dismiss).toBeDefined();
    await act(async () => dismiss?.click());
    expect(el.textContent).not.toContain('Version 2.7.0 is available');
  });

  it('shows the systemd migration notice', async () => {
    const el = await renderApp({
      authenticated: true,
      passwordConfigured: true,
      workspaces: [makeWorkspace()],
      update: { availableVersion: '2.7.0', armedVersion: null, upgradingVersion: null, dismissedVersion: null, migrationRequired: true, mode: { kind: 'systemd' as const }, guardMissing: false, failed: null, idle: { runningAttempts: 0, mergingOrIntegrating: false, conversationMidTurn: false } },
    });

    expect(el.textContent).toContain("Upgrading from the app is off until you re-run sudo harmonic install, which reuses this service's existing port, host, data directory, and password.");
  });

  it('shows the agent-drain notice and cancel action for an armed update', async () => {
    const el = await renderApp({
      authenticated: true,
      passwordConfigured: true,
      workspaces: [makeWorkspace()],
      update: { availableVersion: '2.7.0', armedVersion: '2.7.0', upgradingVersion: null, dismissedVersion: null, migrationRequired: false, mode: { kind: 'systemd' as const }, guardMissing: false, failed: null, idle: { runningAttempts: 0, mergingOrIntegrating: false, conversationMidTurn: true } },
    });

    expect(el.textContent).toContain('waiting for agent before updating');
    expect([...el.querySelectorAll('button')].some((button) => button.textContent === 'Cancel')).toBe(true);
  });

  it('shows the upgrade takeover only while the server reports a swap in progress', async () => {
    const el = await renderApp({
      authenticated: true,
      passwordConfigured: true,
      workspaces: [makeWorkspace()],
      update: { availableVersion: '2.7.0', armedVersion: '2.7.0', upgradingVersion: '2.7.0', dismissedVersion: null, migrationRequired: false, mode: { kind: 'systemd' as const }, guardMissing: false, failed: null, idle: { runningAttempts: 0, mergingOrIntegrating: false, conversationMidTurn: false } },
    });

    expect(el.textContent).toContain('Updating to v2.7.0 — Harmonic will restart, this page reconnects automatically.');
  });

  it('holds the upgrade takeover through a failed status poll and clears it after reconnecting to the new version', async () => {
    const upgrading = { availableVersion: '2.7.0', armedVersion: '2.7.0', upgradingVersion: '2.7.0', dismissedVersion: null, migrationRequired: false, mode: { kind: 'systemd' as const }, guardMissing: false, failed: null, idle: { runningAttempts: 0, mergingOrIntegrating: false, conversationMidTurn: false } };
    const complete = { ...upgrading, armedVersion: null, upgradingVersion: null };
    vi.useFakeTimers();
    const el = await renderApp({
      authenticated: true,
      passwordConfigured: true,
      workspaces: [makeWorkspace()],
      updateResponses: [upgrading, 'offline', complete],
    });

    expect(el.textContent).toContain('Updating to v2.7.0');
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(el.textContent).toContain('Updating to v2.7.0');
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(el.textContent).not.toContain('Updating to v2.7.0');
    vi.useRealTimers();
  });

  it('polls immediately after arming so the server-reported handoff reaches the takeover', async () => {
    const available = { availableVersion: '2.7.0', armedVersion: null, upgradingVersion: null, dismissedVersion: null, migrationRequired: false, mode: { kind: 'systemd' as const }, guardMissing: false, failed: null, idle: { runningAttempts: 0, mergingOrIntegrating: false, conversationMidTurn: false } };
    const upgrading = { ...available, armedVersion: '2.7.0', upgradingVersion: '2.7.0' };
    const el = await renderApp({
      authenticated: true,
      passwordConfigured: true,
      workspaces: [makeWorkspace()],
      updateResponses: [available, upgrading],
    });

    const upgrade = [...el.querySelectorAll('button')].find((button) => button.textContent === 'Upgrade');
    await act(async () => upgrade?.click());
    await flush();

    expect(el.textContent).toContain('Updating to v2.7.0');
  });

  it('arms and cancels an update from the banner', async () => {
    const el = await renderApp({
      authenticated: true,
      passwordConfigured: true,
      workspaces: [makeWorkspace()],
      update: { availableVersion: '2.7.0', armedVersion: null, upgradingVersion: null, dismissedVersion: null, migrationRequired: false, mode: { kind: 'systemd' as const }, guardMissing: false, failed: null, idle: { runningAttempts: 1, mergingOrIntegrating: false, conversationMidTurn: false } },
    });

    const upgrade = [...el.querySelectorAll('button')].find((button) => button.textContent === 'Upgrade');
    await act(async () => upgrade?.click());
    await flush();
    expect([...el.querySelectorAll('button')].some((button) => button.textContent === 'Cancel')).toBe(true);

    const cancel = [...el.querySelectorAll('button')].find((button) => button.textContent === 'Cancel');
    await act(async () => cancel?.click());
    await flush();
    expect([...el.querySelectorAll('button')].some((button) => button.textContent === 'Upgrade')).toBe(true);
  });

  it('renders Login, not the app shell, when unauthenticated', async () => {
    const el = await renderApp({ authenticated: false, passwordConfigured: true });

    expect(el.querySelector('input[aria-label="Operator password"]')).not.toBeNull();
    expect(el.textContent).toContain('Log in');
    expect(el.querySelector('nav[aria-label="Views"]')).toBeNull();
  });

  it('shows the no-workspace empty state once authed with no workspaces', async () => {
    const el = await renderApp({ authenticated: true, passwordConfigured: false, workspaces: [] });

    expect(el.textContent).toContain('No workspace open');
    expect(el.querySelector('button[aria-label="Operator password"]')).toBeNull();
  });

  it('renders the app shell (rail + New task) once a workspace is active', async () => {
    const el = await renderApp({
      authenticated: true,
      passwordConfigured: true,
      workspaces: [makeWorkspace()],
    });

    expect(el.querySelector('nav[aria-label="Views"]')).not.toBeNull();
    const newTaskButton = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('New task'));
    expect(newTaskButton).toBeDefined();
  });

  it('defaults the homepage to the sole workspace board when only one workspace exists', async () => {
    const el = await renderApp({
      authenticated: true,
      passwordConfigured: true,
      workspaces: [makeWorkspace()],
    });

    expect(window.location.pathname).toBe('/workspace/1/board');
    expect(el.textContent).not.toContain('Dashboard');
  });

  it('shows the dashboard at the homepage when multiple workspaces exist', async () => {
    const el = await renderApp({
      authenticated: true,
      passwordConfigured: true,
      workspaces: [makeWorkspace({ id: 1, name: 'Workspace One' }), makeWorkspace({ id: 2, name: 'Workspace Two' })],
    });

    expect(window.location.pathname).toBe('/');
    expect(el.textContent).toContain('Dashboard');
  });

  it('stays on the dashboard once navigated there with one workspace, without bouncing back', async () => {
    const el = await renderApp({
      authenticated: true,
      passwordConfigured: true,
      workspaces: [makeWorkspace()],
    });
    expect(window.location.pathname).toBe('/workspace/1/board');

    await act(async () => window.history.pushState(null, '', '/'));
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flush();

    expect(window.location.pathname).toBe('/');
    expect(el.textContent).toContain('Dashboard');
  });

  it('reaches the dashboard from the workspace switcher with one workspace and stays there', async () => {
    const el = await renderApp({
      authenticated: true,
      passwordConfigured: true,
      workspaces: [makeWorkspace()],
    });
    expect(window.location.pathname).toBe('/workspace/1/board');

    const switcher = el.querySelector<HTMLButtonElement>('button[aria-label="Active workspace"]');
    await act(async () => switcher?.click());
    const globalOption = [...el.querySelectorAll('li[role="option"]')].find((li) => li.textContent === 'Global');
    await act(async () => globalOption?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    await flush();

    expect(window.location.pathname).toBe('/');
    expect(el.textContent).toContain('Dashboard');
  });

  it('exposes the theme toggle and Settings rail entry once a workspace is active', async () => {
    const el = await renderApp({
      authenticated: true,
      passwordConfigured: true,
      workspaces: [makeWorkspace()],
    });

    const themeButton = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      (b.getAttribute('aria-label') ?? '').startsWith('Theme:'),
    );
    expect(themeButton).toBeDefined();
    expect([...el.querySelectorAll('nav[aria-label="Views"] button')].some((button) => button.textContent === 'Settings')).toBe(true);
  });

  it('shows and clears the global permission alert outside Activity', async () => {
    window.history.replaceState(null, '', '/workspace/1/conversations/99');
    const el = await renderApp({
      authenticated: true,
      passwordConfigured: true,
      workspaces: [makeWorkspace()],
      conversation: makeConversation(),
    });

    await act(async () => {
      IdleWebSocket.latest?.emit({
        type: 'permission_request',
        conversationId: 12,
        reqId: 'request-12',
        request: {
          sessionId: 'session-12',
          toolCall: { title: 'Run the deployment', kind: 'execute' },
          options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
        },
      });
    });
    await flush();

    expect(el.textContent).toContain('Fix the deployment needs your permission');
    const answerButton = el.querySelector<HTMLButtonElement>('button[aria-label="Open conversation Fix the deployment"]');
    expect(answerButton).not.toBeNull();

    await act(async () => answerButton?.click());
    await flush();

    expect(el.textContent).toContain('Fix the deployment');

    await act(async () => {
      IdleWebSocket.latest?.emit({
        type: 'conversation_event',
        event: {
          id: 1,
          conversationId: 12,
          seq: 1,
          ts: 1,
          type: 'permission_request',
          payload: { reqId: 'request-12' },
        },
      });
    });
    await flush();

    expect(el.textContent).not.toContain('Fix the deployment needs your permission');
    expect([...el.querySelectorAll('button')].some((button) => button.textContent === 'Allow once')).toBe(false);

    await act(async () => {
      IdleWebSocket.latest?.emit({
        type: 'permission_request',
        conversationId: 12,
        reqId: 'request-13',
        request: {
          sessionId: 'session-12',
          toolCall: { title: 'Deploy the fix', kind: 'execute' },
          options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
        },
      });
    });
    await flush();

    expect(el.textContent).toContain('Fix the deployment needs your permission');

    await act(async () => {
      IdleWebSocket.latest?.emit({
        type: 'conversation_changed',
        conversation: makeConversation({ state: 'ended', endedAt: 1 }),
      });
    });
    await flush();

    expect(el.textContent).not.toContain('Fix the deployment needs your permission');
  });
});
