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
    defaults: { harness: 'claude', isolationMode: 'direct', priority: 'normal', conflictResolveTurns: 2, workflow: null, epicWorkflow: null },
    chat: { harness: 'claude', model: 'claude-sonnet-4-6' },
    excludedDirectories: ['.git', 'node_modules'],
    autoRunner: { enabled: false, maxConcurrentAttempts: 2 },
    agentMessages: { enabled: false, sendCap: 10 },
    classifier: { workflowEnabled: false, enabled: false, backend: 'harness', timeoutSeconds: 30, typesafeModel: 'typesafe/jev-1.13', typesafeSecret: null, harness: null, model: null },
    verify: { epic: { preMerge: { commands: [], critics: [] }, resolvePrompt: 'Resolve failures.', resolveSuffix: '' } },
    guardrails: { budget: { wallClockMinutes: 60, tokens: null, costUsd: null }, progress: false, toolTimeoutMinutes: 10 },
    drive: { prompt: '', unattendedReminder: '', continuePrompt: '', commitNudge: '' },
    contextReuseTokenLimit: 100_000,
    routingLabels: [],
    workflowLabels: [],
    modelOptions: [],
    editor: { maxFileSizeBytes: 2_097_152 },
    taskPrompt: '',
    pauseMessage: 'Pause.',
    merge: { postMergeCheck: true, conflictPrompt: '', epicConflictPrompt: '', epicRefreshPrompt: '' },
    archive: { retain: { days: null, maxTotalMB: null } },
    export: {
      enabled: false,
      includeStates: ['done', 'cancelled', 'deleted'],
      directory: { path: null },
      s3: { endpoint: null, region: null, bucket: null, prefix: '', forcePathStyle: false, accessKeyId: null, secretAccessKey: null },
      redact: { patterns: [] },
    },
    ...overrides,
  };
}

export function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 1,
    name: 'Main',
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
    agentMessagesEnabled: null,
    agentMessagesSendCap: null,
    effectiveAgentMessagesEnabled: false,
    maxAttempts: null,
    contextReuseTokenLimit: null,
    routingLabels: null,
    workflow: null,
    workflowLabels: null,
    modelOptions: null,
    executionTargets: null,
    classifierEnabled: null,
    classifierBackend: null,
    classifierTimeoutSeconds: null,
    classifierTypesafeModel: null,
    classifierTypesafeSecret: null,
    classifierHarness: null,
    classifierModel: null,
    classifierEndpoint: null,
    guardrailBudget: null,
    guardrailProgress: null,
    exportEnabled: null,
    exportDirectoryPath: null,
    exportS3Endpoint: null,
    exportS3Region: null,
    exportS3Bucket: null,
    exportS3Prefix: null,
    exportS3ForcePathStyle: null,
    exportS3AccessKeyId: null,
    exportS3SecretAccessKey: null,
    exportRedactPatterns: null,
    exportIncludeStates: null,
    configuredTracker: null,
    codeRepository: null,
    triageLabels: null,
    archiveRetentionDays: null,
    archiveRetentionMaxTotalMB: null,
    toolTimeoutMinutes: null,
    pauseMessage: null,
    mergeEpicConflictPrompt: null,
    mergeEpicRefreshPrompt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
    excludedDirectories: overrides.excludedDirectories ?? [],
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
    escalationCause: null,
    mergeStatus: null, ticketClosePending: false, workflowRef: null, workflowChosen: null,
    feedback: null,
    createdAt: Date.now() - 3_600_000,
    updatedAt: Date.now(),
    dependsOn: [],
    dependents: [],
    blockedOnFailed: false,
    openBlockerCount: 0,
    epicBlockers: [],
    agentWorkable: true,
    humanOnly: false,
    isEpic: false,
    cost: null,
    origin: 'native',
    trackerRef: null,
    issueWorkflow: null,
    wayfinderType: null,
    mapRef: null,
    url: null,
    mapTitle: null,
    trackerLabel: null,
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
    wallClockDeadline: null,
    skipReason: null,
    targetWait: null,
    routing: null,
    modelOptionOverrides: [],
    classifier: null,
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
