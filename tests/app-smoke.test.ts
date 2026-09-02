// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../web/src/App.js';
import type { AppConfig, Workspace } from '../web/src/types.js';

class IdleWebSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(_url: string) {}

  close() {}
}

function makeConfig(): AppConfig {
  return {
    name: '',
    harnesses: {
      claude: { command: 'claude', args: [], env: {}, models: ['claude-sonnet-4-6'], defaultModel: 'claude-sonnet-4-6' },
    },
    prices: {},
    defaults: { harness: 'claude', workingDir: '/tmp', isolationMode: 'direct', priority: 'normal', conflictResolveTurns: 2 },
    chat: { harness: 'claude', model: 'claude-sonnet-4-6' },
    autoRunner: { enabled: false, maxConcurrentAttempts: 2 },
    verify: { commands: [], review: { enabled: false } },
    guardrails: { budget: { wallClockMinutes: 60, tokens: null, costUsd: null }, progress: false, toolTimeoutMinutes: 10 },
    drive: { prompt: '', unattendedReminder: '', continuePrompt: '', mergeFate: 'auto-merge', continueAttempts: 0 },
    maxAttempts: 3,
    contextReuseTokenLimit: 100_000,
    taskPrompt: '',
  };
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 1,
    name: 'Workspace One',
    workingDir: '/tmp/ws1',
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
    verificationCommand: null,
    reviewEnabled: null,
    reviewPrompt: null,
    reviewModel: null,
    reviewHarness: null,
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
  };
}

function stubFetch(opts: { authenticated: boolean; passwordConfigured: boolean; workspaces?: Workspace[] }) {
  const workspaces = opts.workspaces ?? [];
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const path = String(input instanceof Request ? input.url : input);
    if (path === '/api/auth/me') {
      return new Response(JSON.stringify({ authenticated: opts.authenticated, passwordConfigured: opts.passwordConfigured }));
    }
    if (path === '/api/config') return new Response(JSON.stringify(makeConfig()));
    if (path === '/api/workspaces') return new Response(JSON.stringify({ workspaces, total: workspaces.length }));
    if (path.startsWith('/api/tasks')) return new Response(JSON.stringify({ tasks: [], total: 0 }));
    if (path.includes('/epics')) return new Response(JSON.stringify({ epics: [], total: 0 }));
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
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function renderApp(opts: { authenticated: boolean; passwordConfigured: boolean; workspaces?: Workspace[] }) {
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

  it('exposes the theme toggle and Settings entry points once a workspace is active', async () => {
    const el = await renderApp({
      authenticated: true,
      passwordConfigured: true,
      workspaces: [makeWorkspace()],
    });

    const themeButton = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      (b.getAttribute('aria-label') ?? '').startsWith('Theme:'),
    );
    expect(themeButton).toBeDefined();
    expect(el.querySelector('button[aria-label="Settings"]')).not.toBeNull();
  });
});
