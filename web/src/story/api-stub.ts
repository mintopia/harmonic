/* eslint-disable */
import * as f from './fixtures';
import { conversationDetail, conversationEventsFixture, conversationList, permissionRulesFixture } from './conversation-fixtures';
import type { api as RealApi } from '../api';
import type {
  ActivityProcess,
  AppConfig,
  Attempt,
  AttemptEvent,
  AttemptState,
  Channel,
  ConfigLayers,
  DiffFile,
  ElicitationAnswer,
  FsListing,
  GitStatusEntry,
  Task,
  UpdateState,
  Workspace,
} from '../types.js';
import type { EpicIntegrateOutcome } from '../epic-model.js';
import type { WorktreeInventoryEntry } from '../worktree-inventory-model.js';

const ok = <T>(v: T) => Promise.resolve(v);

const FILE_TREE: Record<string, any[]> = {
  '': [
    { name: 'src', path: 'src', type: 'directory', size: 0, excluded: false },
    { name: 'web', path: 'web', type: 'directory', size: 0, excluded: false },
    { name: 'node_modules', path: 'node_modules', type: 'directory', size: 0, excluded: true },
    { name: 'package.json', path: 'package.json', type: 'file', size: 1840, excluded: false },
    { name: 'README.md', path: 'README.md', type: 'file', size: 3120, excluded: false },
    { name: '.gitignore', path: '.gitignore', type: 'file', size: 210, excluded: false },
  ],
  src: [
    { name: 'config.ts', path: 'src/config.ts', type: 'file', size: 2210, excluded: false },
    { name: 'index.ts', path: 'src/index.ts', type: 'file', size: 940, excluded: false },
    { name: 'db', path: 'src/db', type: 'directory', size: 0, excluded: false },
  ],
  web: [
    { name: 'App.tsx', path: 'web/App.tsx', type: 'file', size: 4100, excluded: false },
  ],
};

const CONFIG_TS = `import { parse } from 'yaml';
import baselineYaml from './baseline.yaml?raw';

/** Per-workspace guardrail ceilings, resolved fleet-wide then per task. */
export interface WorkspaceConfig {
  maxAttempts: number;
  tokenBudget: number | null;
  wallClockCapMs: number | null;
}

export const GUARDRAIL_DEFAULTS = {
  maxAttempts: 6,
  tokenBudget: null,
} as const;

// A task-level override still wins where present.
export function resolveGuardrails(task: Task, workspace: WorkspaceConfig) {
  return { ...GUARDRAIL_DEFAULTS, ...workspace, ...task.overrides };
}

export const config = parse(baselineYaml);
`;

const fileText = (path: string): string | null => {
  if (path === 'src/config.ts') return CONFIG_TS;
  if (path === 'README.md') return '# Harmonic\n\nAn operator-grade agent fleet console.\n\n- Board\n- Timeline\n- Stats\n';
  if (path === 'package.json') return '{\n  "name": "harmonic",\n  "version": "1.4.0"\n}\n';
  return '// ' + path + '\n';
};

const gitStatusEntries: GitStatusEntry[] = [
  { path: 'src/config.ts', indexStatus: 'M', worktreeStatus: '.' },
  { path: 'src/db/schema.ts', indexStatus: '.', worktreeStatus: 'M' },
  { path: 'README.md', indexStatus: 'A', worktreeStatus: '.' },
  { path: 'web/new-panel.tsx', indexStatus: '?', worktreeStatus: '?' },
];

const dashboardWorkspaces = [
  { workspaceId: 1, name: 'harmonic', color: '#3AA0FA', cost: { totalUsd: 34.5, byModel: {}, incomplete: false }, inputTokens: 620_000, outputTokens: 82_000, cacheReadTokens: 3_100_000, cacheWriteTokens: 460_000, tasks: 12, failureRate: 0.14 },
  { workspaceId: 2, name: 'website', color: '#B06BF5', cost: { totalUsd: 7.68, byModel: {}, incomplete: false }, inputTokens: 232_000, outputTokens: 23_000, cacheReadTokens: 640_000, cacheWriteTokens: 98_000, tasks: 4, failureRate: 0.25 },
  { workspaceId: 3, name: 'docs', color: '#3FD08A', cost: { totalUsd: 2.11, byModel: {}, incomplete: false }, inputTokens: 84_000, outputTokens: 9_000, cacheReadTokens: 190_000, cacheWriteTokens: 31_000, tasks: 2, failureRate: 0 },
  { workspaceId: 4, name: 'infra-scripts', color: '#F5A623', cost: null, inputTokens: 41_000, outputTokens: 5_000, cacheReadTokens: 88_000, cacheWriteTokens: 12_000, tasks: 1, failureRate: null },
];
const dashboardStats = { ...f.statsFixture, byWorkspace: dashboardWorkspaces };

const activityDefaults = { trackerUrl: null, escalated: false, usage: null, contextTokens: null, contextWindow: null, activity: null, tree: null, cost: null } as const;
const activityProcesses: ActivityProcess[] = [
  { type: 'attempt', attemptId: 9001, conversationId: null, taskId: 503, title: 'Per-task override UI + inherit toggle', workspaceId: 1, workspaceName: 'harmonic', harness: 'codex', model: 'gpt-5.1', state: 'running', isolation: 'worktree', startedAt: Date.now() - 9 * 60_000, trackerRef: 142, ...activityDefaults },
  { type: 'attempt', attemptId: 9002, conversationId: null, taskId: 455, title: 'Baseline schema-sync boot repair', workspaceId: 1, workspaceName: 'harmonic', harness: 'claude', model: 'claude-opus-4-8', state: 'running', isolation: 'worktree', startedAt: Date.now() - 3 * 60_000, trackerRef: 455, ...activityDefaults },
  { type: 'chat', attemptId: null, conversationId: 12, taskId: null, title: 'Sketching the dashboard band layout', workspaceId: 2, workspaceName: 'website', harness: 'claude', model: 'claude-sonnet-5', state: 'warm', isolation: 'direct', startedAt: Date.now() - 25 * 60_000, trackerRef: null, ...activityDefaults },
];

const H = 3600_000;
const cost = (model: string, usd: number) => ({ totalUsd: usd, byModel: { [model]: usd }, incomplete: false });
/** Fleet-Timeline spans relative to `to` (now): three harness lanes, every
 * outcome, two live runs and an overlap that forces a codex sub-row. Finished
 * runs carry a frozen Cost; running ones have none yet (honest floor). */
const TL_REF = Date.now();
interface TimelineSpanBase {
  taskId: number;
  attemptId: number;
  number: number;
  title: string;
  harness: string;
  model: string;
  state: AttemptState;
  trackerRef: number;
  startedAt: number;
  endedAt: number | null;
}

const timelineSpans = (to: number = TL_REF) => {
  const t = (hoursAgo: number) => Math.round(to - hoursAgo * H);
  const base: TimelineSpanBase[] = [
    // Deeper history so zooming out / panning back reveals more than the last day.
    { taskId: 4800, attemptId: 20, number: 1, title: 'Retire .harmonic-live reaper', harness: 'claude', model: 'claude-opus-4-8', state: 'passed', trackerRef: 401, startedAt: t(120), endedAt: t(117.5) },
    { taskId: 4801, attemptId: 21, number: 2, title: 'Epic follows develop advance', harness: 'codex', model: 'gpt-5.6', state: 'failed', trackerRef: 435, startedAt: t(74), endedAt: t(71) },
    { taskId: 4802, attemptId: 22, number: 1, title: 'Baseline schema-sync boot repair', harness: 'copilot', model: 'gpt-5.6', state: 'passed', trackerRef: 455, startedAt: t(50), endedAt: t(47.2) },
    { taskId: 4821, attemptId: 1, number: 1, title: 'Worktree inventory API', harness: 'claude', model: 'claude-opus-4-8', state: 'passed', trackerRef: 481, startedAt: t(22), endedAt: t(21.1) },
    { taskId: 4822, attemptId: 2, number: 2, title: 'Rate-limit ACP reconnect', harness: 'claude', model: 'claude-opus-4-8', state: 'escalated', trackerRef: 470, startedAt: t(19.5), endedAt: t(18) },
    { taskId: 4823, attemptId: 3, number: 1, title: 'Post-merge revert-on-red', harness: 'claude', model: 'claude-opus-4-8', state: 'passed', trackerRef: 460, startedAt: t(9.5), endedAt: t(8.1) },
    { taskId: 4824, attemptId: 4, number: 2, title: 'AA-clear the running amber', harness: 'claude', model: 'claude-sonnet-5', state: 'running', trackerRef: 458, startedAt: t(1.7), endedAt: null },
    { taskId: 4840, attemptId: 5, number: 1, title: 'Delete legacy gate module', harness: 'codex', model: 'gpt-5.6', state: 'passed', trackerRef: 380, startedAt: t(21), endedAt: t(19.4) },
    { taskId: 4841, attemptId: 6, number: 1, title: 'Force-cleanup orphaned worktrees', harness: 'codex', model: 'gpt-5.6', state: 'passed', trackerRef: 482, startedAt: t(6), endedAt: t(3.6) },
    { taskId: 4842, attemptId: 7, number: 2, title: 'Baseline schema-sync repair', harness: 'codex', model: 'gpt-5.6', state: 'running', trackerRef: 455, startedAt: t(4.2), endedAt: null },
    { taskId: 4850, attemptId: 8, number: 1, title: 'URL carries diff + attempt selection', harness: 'copilot', model: 'gpt-5.6', state: 'passed', trackerRef: 449, startedAt: t(18.5), endedAt: t(16) },
    { taskId: 4851, attemptId: 9, number: 2, title: 'Flaky merge-race guard', harness: 'copilot', model: 'gpt-5.6', state: 'failed', trackerRef: 471, startedAt: t(11), endedAt: t(9.3) },
    { taskId: 4852, attemptId: 10, number: 1, title: 'Reconcile-on-demand button', harness: 'copilot', model: 'gpt-5.6', state: 'cancelled', trackerRef: 488, startedAt: t(5), endedAt: t(4.2) },
  ];
  return base.map((s) => ({
    ...s,
    cost: s.endedAt ? cost(s.model, Math.round((0.18 + (s.attemptId % 5) * 0.27) * 100) / 100) : null,
    workspace: s.taskId % 2 === 0
      ? { id: 1, name: 'harmonic', color: '#3AA0FA' }
      : { id: 2, name: 'website', color: '#B06BF5' },
  }));
};

/** Synthesize one attempt's Steps across its own window, for the Timeline drill-in. */
const syntheticAttempt = (s: ReturnType<typeof timelineSpans>[number]): Attempt => {
  const start = s.startedAt;
  const end = s.endedAt ?? Date.now();
  const at = (frac: number) => Math.round(start + (end - start) * frac);
  const last = s.state === 'running' ? 'running' : s.state === 'failed' ? 'failed' : s.state === 'cancelled' ? 'cancelled' : 'passed';
  return {
    id: s.attemptId,
    taskId: s.taskId,
    number: s.number,
    state: s.state,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    feedback: null,
    verifiedSha: null,
    escalationReason: s.state === 'escalated' ? 'escalated to human' : null,
    verifierStatuses: [],
    continuation: null,
    steps: [
      { id: s.attemptId * 10 + 1, attemptId: s.attemptId, type: 'rebase', position: 1, state: 'passed', command: null, verdict: 'clean', logLocator: null, startedAt: at(0), endedAt: at(0.08) },
      { id: s.attemptId * 10 + 2, attemptId: s.attemptId, type: 'implementation', position: 2, state: s.state === 'running' ? 'passed' : 'passed', command: null, verdict: null, logLocator: null, startedAt: at(0.1), endedAt: at(0.62) },
      { id: s.attemptId * 10 + 3, attemptId: s.attemptId, type: 'verification', position: 3, state: last, command: 'npm test', verdict: last === 'passed' ? 'pass' : last === 'failed' ? 'fail' : null, logLocator: null, startedAt: at(0.66), endedAt: s.state === 'running' ? null : at(0.94) },
      { id: s.attemptId * 10 + 4, attemptId: s.attemptId, type: 'review', position: 4, state: s.state === 'passed' ? 'passed' : 'skipped', command: null, verdict: s.state === 'passed' ? 'pass' : null, logLocator: null, startedAt: s.state === 'passed' ? at(0.96) : null, endedAt: s.state === 'passed' ? at(1) : null },
    ],
  };
};

export const request = <T>() => Promise.resolve(undefined as T);

const updateState: UpdateState = {
  currentVersion: '2.14.0',
  availableVersion: null,
  armedVersion: null,
  dismissedVersion: null,
  idle: { runningAttempts: 0, mergingOrIntegrating: false, conversationMidTurn: false },
};

const configLayers: ConfigLayers = {
  baseline: f.config,
  global: f.config,
  harnessPermissionModes: {},
};

const fsListing = (path?: string): FsListing => ({
  path: path ?? '/home/workspace',
  parent: path && path !== '/' ? path.split('/').slice(0, -1).join('/') || '/' : null,
  entries: [
    { name: 'harmonic', path: `${path ?? '/home/workspace'}/harmonic` },
    { name: 'website', path: `${path ?? '/home/workspace'}/website` },
  ],
});

const worktreeFixtures: WorktreeInventoryEntry[] = [
  { id: 'wt-1', workspaceId: 1, path: '/home/workspace/.harmonic-worktrees/task-172', branch: 'harmonic/task-172', subject: { kind: 'task', taskId: 172, title: f.task.summary }, sizeBytes: 84_000_000, dirty: false, changeCount: 0, state: 'Active' },
  { id: 'wt-2', workspaceId: 1, path: '/home/workspace/.harmonic-worktrees/epic-166', branch: 'epic/166', subject: { kind: 'epic', epicRef: 166, title: f.epic.title }, sizeBytes: 92_000_000, dirty: true, changeCount: 4, state: 'Dirty' },
];

const channelFixtures: Channel[] = [
  { id: 1, name: 'Escalations', type: 'slack', config: { webhookUrl: 'https://hooks.slack.example/…' }, events: ['task.escalated'] },
  { id: 2, name: 'Nightly digest', type: 'email', config: { to: 'operator@example.com' }, events: ['digest.daily'] },
];

const workspaceFixture: Workspace = f.workspaces[0] as Workspace;

export const api: typeof RealApi = {
  harnessProviders: (harness: string) =>
    ok({
      providers:
        harness === 'opencode'
          ? [
              { id: 'anthropic', label: 'Anthropic', authed: true },
              { id: 'openai', label: 'OpenAI', authed: false },
              { id: 'google', label: 'Google', authed: true },
              { id: 'openrouter', label: 'OpenRouter', authed: false },
            ]
          : [],
    }),
  harnessModels: (_harness: string, provider: string) =>
    ok({
      models: provider
        ? [
            { id: `${provider}/claude-sonnet-4.5`, label: 'Sonnet 4.5' },
            { id: `${provider}/gpt-5.6`, label: 'GPT-5.6' },
            { id: `${provider}/gemini-2.5-pro`, label: 'Gemini 2.5 Pro' },
          ]
        : [],
    }),
  config: () => ok(f.config),
  globalPause: () => ok({ paused: false }),
  updateState: () => ok(updateState),
  armUpdate: () => ok({ ...updateState, armedVersion: '2.15.0', availableVersion: '2.15.0' }),
  cancelUpdate: () => ok(updateState),
  dismissUpdate: () => ok({ ...updateState, dismissedVersion: '2.15.0' }),
  checkUpdate: () => ok(updateState),
  pauseGlobal: () => ok({ paused: true }),
  resumeGlobal: () => ok({ paused: false }),
  configLayers: () => ok(configLayers),
  updateConfig: (_patch: object) => ok(f.config),
  replaceConfig: (_config: AppConfig) => ok(f.config),
  revertConfig: () => ok(f.config),
  tasks: (opts?: { workspaceId?: number; state?: 'open'; parent?: number; limit?: number; offset?: number }) =>
    opts?.parent !== undefined ? ok({ tasks: f.epicChildren, total: f.epicChildren.length }) : ok({ tasks: [f.task], total: 1 }),
  task: (_id: number) => ok(f.task),
  stats: (_from: number, _to: number, _workspaceId?: number) => ok(dashboardStats),
  activity: () => ok({ processes: activityProcesses }),
  timeline: (_workspaceId: number | undefined, from: number, to: number) =>
    ok({ attempts: timelineSpans().filter((s) => s.startedAt <= to && (s.endedAt ?? Date.now()) >= from), from, to }),
  epicStats: (_epicRef: number, _workspaceId: number) => ok(f.epicStats),
  createTask: (_input: Partial<Task> & { prompt: string; state?: 'draft' | 'ready' }) => ok(f.task),
  browseFs: (path?: string) => ok(fsListing(path)),
  workspaceFiles: (_workspaceId: number, path = '', offset = 0) => {
    const entries = FILE_TREE[path] ?? [];
    return ok({ path, entries, total: entries.length, limit: 100, offset });
  },
  workspaceFile: (_workspaceId: number, path: string) => {
    const text = fileText(path);
    return ok({ text, mime: 'text/plain', size: text?.length ?? 0, isBinary: false, isTooLarge: false });
  },
  workspaceRawUrl: (_workspaceId: number, path: string) => `/raw/${path}`,
  saveWorkspaceFile: (_workspaceId: number, _path: string, text: string) =>
    ok({ text, mime: 'text/plain', size: text.length, isBinary: false, isTooLarge: false }),
  createWorkspaceEntry: (_workspaceId: number, path: string, type: 'file' | 'directory') =>
    ok({ name: path.split('/').pop() ?? path, path, type, size: 0, excluded: false }),
  moveWorkspaceEntry: (_workspaceId: number, _from: string, to: string) =>
    ok({ name: to.split('/').pop() ?? to, path: to, type: 'file' as const, size: 0, excluded: false }),
  deleteWorkspaceEntry: (_workspaceId: number, _path: string) => ok({ ok: true as const }),
  gitStatus: (_workspaceId: number) => ok({ entries: gitStatusEntries }),
  stageGitPaths: (_workspaceId: number, _paths: string[]) => ok({ ok: true as const }),
  unstageGitPaths: (_workspaceId: number, _paths: string[]) => ok({ ok: true as const }),
  discardGitPaths: (_workspaceId: number, _paths: string[]) => ok({ ok: true as const }),
  commitGitChanges: (_workspaceId: number, _message: string) => ok({ ok: true as const }),
  gitFileDiff: (_workspaceId: number, _path: string) => ok({ file: (f.diffFiles[0] as DiffFile | undefined) ?? null }),
  worktrees: (_opts?: { workspaceId?: number; limit?: number; offset?: number }) =>
    ok({ worktrees: worktreeFixtures, total: worktreeFixtures.length, reconciledAt: Date.now() }),
  dirtyWorktreeFiles: (_id: string, _workspaceId?: number) => ok({ files: ['src/config.ts'] }),
  cleanupWorktree: (_id: string, _workspaceId?: number) => ok({ removed: true }),
  reconcileWorktrees: (_workspaceId?: number) => ok({ removed: 0, recreated: 0, flagged: 0 }),
  workspaces: () => ok({ workspaces: f.workspaces, total: f.workspaces.length }),
  createWorkspace: (_input: { name: string; workingDir: string }) => ok(workspaceFixture),
  updateWorkspace: (_id: number, _patch: object) => ok(workspaceFixture),
  deleteWorkspace: (_id: number) => ok(null),
  refreshTracker: (_id: number) => ok({ ok: true as const }),
  updateTask: (_id: number, _input: object) => ok(f.task),
  promoteTask: (_id: number) => ok(f.task),
  cancelTask: (_id: number, _withDependents = false) => ok(f.task),
  pauseTask: (_id: number) => ok(f.task),
  resumeTask: (_id: number, _continuation?: 'full' | 'condensed') => ok(f.task),
  completeTask: (_id: number) => ok(f.task),
  steerTask: (_id: number, _msg: string) => ok({ ok: true as const }),
  extendGuardrail: (_id: number, _minutes: number) => ok(f.task),
  uncancelTask: (_id: number) => ok(f.task),
  addDependency: (_id: number, _dependsOnId: number) => ok(f.task),
  removeDependency: (_id: number, _depId: number) => ok(f.task),
  continuationPreview: (_id: number) => ok({ available: false as const }),
  rejectEpic: (_workspaceId: number, _epicRef: number, _guidance: string, _continuation: 'continue' | 'fresh') =>
    ok<EpicIntegrateOutcome>({ status: 'integrated', oid: 'a1b2c3d' }),
  acceptTask: (_id: number) => ok(f.task),
  rejectTask: (_id: number, _guidance: string, _start = false) => ok(f.task),
  closeTask: (_id: number) => ok(f.task),
  deleteTask: (id: number) => ok({ id }),
  runTask: (_id: number) => ok(f.runs[2] ?? f.runs[0]!),
  taskAttempts: (_id: number) => ok({ attempts: f.runs, total: f.runs.length }),
  taskAttemptTimeline: (id: number) => {
    const s = timelineSpans().find((x) => x.taskId === id);
    return s
      ? ok({ attempts: [syntheticAttempt(s)], budgetBase: 0, total: 1 })
      : ok({ attempts: f.attempts, budgetBase: 0, total: f.attempts.length });
  },
  taskTimeline: (_id: number) => ok({ events: f.timeline, total: f.timeline.length }),
  taskUsage: (id: number) =>
    ok(f.epicChildUsage[id] ?? { models: {}, agents: {}, toolCalls: {}, totals: null, source: null, cost: null, attemptCount: 0 }),
  attempt: (_id: number) => ok(f.runs[2] ?? f.runs[0]!),
  currentAttempt: (_taskId: number) => ok(f.runs[f.runs.length - 1] ?? f.runs[0]!),
  attemptEvents: (_id: number) => ok<{ events: AttemptEvent[]; total: number }>({ events: [], total: 0 }),
  attemptLog: (_id: number) => ok({ status: 'available' as const, events: f.attemptLog, liveCursor: 999 }),
  attemptGuardrailEvents: (_id: number) => ok({ guardrailEvents: [], total: 0 }),
  attemptVerificationAttempts: (_id: number) => ok({ verificationAttempts: f.verificationAttempts, verifierStatuses: f.verifierStatuses, total: f.verificationAttempts.length }),
  verificationAttempt: (_id: number) => ok({ output: '', summary: 'pass', hasTranscript: false }),
  criticLog: (_id: number) => ok({ status: 'available' as const, events: f.criticLog, liveCursor: 999 }),
  attemptDiff: (_id: number) => ok({ branch: f.task.branch ?? null, baseBranch: f.task.baseBranch ?? null, stat: f.task.stat }),
  attemptDiffFiles: (_id: number) => ok({ files: f.diffFiles, total: f.diffFiles.length }),
  changePassword: (_currentPassword: string, _newPassword: string) => ok({ ok: true as const }),
  removePassword: (_currentPassword: string) => ok({ ok: true as const }),
  conversations: (_workspaceId?: number) => ok({ conversations: conversationList, total: conversationList.length }),
  conversation: (_id: number) => ok(conversationDetail),
  createConversation: (_input?: object) => ok(conversationDetail),
  renameConversation: (_id: number, _title: string | null) => ok(conversationDetail),
  setConversationPermissionMode: (_id: number, _permissionMode: 'ask' | 'automatic') => ok(conversationDetail),
  deleteConversation: (_id: number) => ok({ ok: true as const }),
  conversationEvents: (_id: number) => ok({ events: conversationEventsFixture, total: conversationEventsFixture.length }),
  sendTurn: (_id: number, _text: string) => ok({ ok: true as const, queued: false }),
  endConversation: (_id: number) => ok(conversationDetail),
  interrupt: (_id: number, _text?: string) => ok({ ok: true as const }),
  answerPermission: (_conversationId: number, _reqId: string, _optionId: string, _remember?: boolean) => ok({ ok: true as const }),
  answerElicitation: (_conversationId: number, _reqId: string, _answer: ElicitationAnswer) => ok({ ok: true as const }),
  permissionRules: () => ok({ rules: permissionRulesFixture, total: permissionRulesFixture.length }),
  deletePermissionRule: (_id: number) => ok(undefined),
  channels: () => ok({ channels: channelFixtures, total: channelFixtures.length }),
  createChannel: (input: { name: string; type: Channel['type']; config: Record<string, unknown> }) =>
    ok({ id: channelFixtures.length + 1, name: input.name, type: input.type, config: input.config, events: [] }),
  updateChannel: (id: number, patch: { events: string[] }) =>
    ok({ ...(channelFixtures.find((c) => c.id === id) ?? channelFixtures[0]!), events: patch.events }),
  deleteChannel: (_id: number) => ok(undefined),
  epics: (_workspaceId: number, _opts?: { limit?: number; offset?: number; q?: string }) => ok({ epics: [f.epic], total: 1 }),
  epic: (_workspaceId: number, _epicRef: number) => ok(f.epic),
  epicAttempts: (_workspaceId: number, _epicRef: number) => ok({ attempts: [] }),
  forceIntegrateEpic: (_workspaceId: number, _epicRef: number) => ok<EpicIntegrateOutcome>({ status: 'integrated', oid: 'a1b2c3d' }),
  epicDiffFiles: (_workspaceId: number, _epicRef: number) => ok({ files: f.diffFiles, total: f.diffFiles.length }),
  maps: (_opts?: { workspaceId?: number; limit?: number; offset?: number; q?: string }) => ok({ maps: [], total: 0 }),
};
