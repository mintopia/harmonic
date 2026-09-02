import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';
import type { AppConfig, Task, Workspace } from '../web/src/types.js';

class IdleWebSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(_url: string) {}

  close() {}
}

class IdleResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
}
if (!HTMLDialogElement.prototype.close) {
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    name: '',
    harnesses: { claude: { command: 'claude', args: [], env: {}, models: [{ id: 'claude-sonnet-4-6' }], defaultModel: 'claude-sonnet-4-6', cacheWarmSeconds: 300 } },
    defaults: { harness: 'claude', workingDir: '/tmp', isolationMode: 'direct', priority: 'normal', conflictResolveTurns: 2 },
    chat: { harness: 'claude', model: 'claude-sonnet-4-6' },
    autoRunner: { enabled: false, maxConcurrentAttempts: 2 },
    verify: { commands: [], review: { enabled: false } },
    guardrails: { budget: { wallClockMinutes: 60, tokens: null, costUsd: null }, progress: false, toolTimeoutMinutes: 10 },
    drive: { prompt: '', unattendedReminder: '', continuePrompt: '', mergeFate: 'auto-merge', continueAttempts: 0 },
    maxAttempts: 3,
    contextReuseTokenLimit: 100_000,
    taskPrompt: '',
    ...overrides,
  };
}

export function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 1,
    name: 'Main',
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

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 42,
    prompt: 'Fix the flaky retry test',
    summary: 'Fix the flaky retry test',
    workspaceId: 1,
    harness: 'claude',
    model: 'claude-sonnet-4-6',
    workingDir: '/tmp/ws1',
    isolationMode: 'worktree',
    baseBranch: null,
    priority: 'normal',
    conflictResolveTurns: 2,
    overrides: { harness: null, model: null, isolationMode: null, priority: null, conflictResolveTurns: null },
    state: 'ready',
    escalationReason: null,
    mergeStatus: null,
    feedback: null,
    createdAt: Date.now() - 3_600_000,
    updatedAt: Date.now(),
    dependsOn: [],
    dependents: [],
    blockedOnFailed: false,
    openBlockerCount: 0,
    agentWorkable: true,
    humanOnly: false,
    isEpic: false,
    cost: null,
    origin: 'native',
    trackerRef: null,
    workflow: null,
    wayfinderType: null,
    mapRef: null,
    url: null,
    mapTitle: null,
    branch: null,
    stat: null,
    runStartedAt: null,
    toolCount: null,
    attemptId: null,
    currentStep: null,
    contextTokens: null,
    contextWindow: null,
    verifiedRef: null,
    hasCandidate: false,
    skipReason: null,
    ...overrides,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

export async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// stubbed here (not just at module load) so they still apply after cleanup()'s unstubAllGlobals runs between tests
export async function mountComponent(element: ReactElement): Promise<HTMLDivElement> {
  vi.stubGlobal('WebSocket', IdleWebSocket);
  vi.stubGlobal('ResizeObserver', IdleResizeObserver);
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  await act(async () => {
    root?.render(element);
    await flush();
  });
  return host;
}

export async function cleanup() {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
}
