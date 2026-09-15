/* eslint-disable */
import * as f from './fixtures';
import { conversationDetail, conversationEventsFixture, conversationList, permissionRulesFixture } from './conversation-fixtures';

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

const gitStatusEntries = [
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

const activityProcesses = [
  { type: 'attempt', attemptId: 9001, conversationId: null, taskId: 503, title: 'Per-task override UI + inherit toggle', workspaceId: 1, workspaceName: 'harmonic', harness: 'codex', model: 'gpt-5.1', state: 'running', isolation: 'worktree', startedAt: Date.now() - 9 * 60_000, trackerRef: 142 },
  { type: 'attempt', attemptId: 9002, conversationId: null, taskId: 455, title: 'Baseline schema-sync boot repair', workspaceId: 1, workspaceName: 'harmonic', harness: 'claude', model: 'claude-opus-4-8', state: 'running', isolation: 'worktree', startedAt: Date.now() - 3 * 60_000, trackerRef: 455 },
  { type: 'chat', attemptId: null, conversationId: 12, taskId: null, title: 'Sketching the dashboard band layout', workspaceId: 2, workspaceName: 'website', harness: 'claude', model: 'claude-sonnet-5', state: 'warm', isolation: 'direct', startedAt: Date.now() - 25 * 60_000, trackerRef: null },
];

const H = 3600_000;
const cost = (model: string, usd: number) => ({ totalUsd: usd, byModel: { [model]: usd }, incomplete: false });
/** Fleet-Timeline spans relative to `to` (now): three harness lanes, every
 * outcome, two live runs and an overlap that forces a codex sub-row. Finished
 * runs carry a frozen Cost; running ones have none yet (honest floor). */
const TL_REF = Date.now();
const timelineSpans = (to: number = TL_REF) => {
  const t = (hoursAgo: number) => Math.round(to - hoursAgo * H);
  const base = [
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
const syntheticAttempt = (s: ReturnType<typeof timelineSpans>[number]) => {
  const start = s.startedAt;
  const end = s.endedAt ?? Date.now();
  const at = (frac: number) => Math.round(start + (end - start) * frac);
  const last = s.state === 'running' ? 'running' : s.state === 'failed' ? 'failed' : s.state === 'cancelled' ? 'cancelled' : 'passed';
  return {
    id: s.attemptId,
    steps: [
      { id: s.attemptId * 10 + 1, attemptId: s.attemptId, type: 'rebase', position: 1, state: 'passed', command: null, verdict: 'clean', logLocator: null, startedAt: at(0), endedAt: at(0.08) },
      { id: s.attemptId * 10 + 2, attemptId: s.attemptId, type: 'implementation', position: 2, state: s.state === 'running' ? 'passed' : 'passed', command: null, verdict: null, logLocator: null, startedAt: at(0.1), endedAt: at(0.62) },
      { id: s.attemptId * 10 + 3, attemptId: s.attemptId, type: 'verification', position: 3, state: last, command: 'npm test', verdict: last === 'passed' ? 'pass' : last === 'failed' ? 'fail' : null, logLocator: null, startedAt: at(0.66), endedAt: s.state === 'running' ? null : at(0.94) },
      { id: s.attemptId * 10 + 4, attemptId: s.attemptId, type: 'review', position: 4, state: s.state === 'passed' ? 'passed' : 'skipped', command: null, verdict: s.state === 'passed' ? 'pass' : null, logLocator: null, startedAt: s.state === 'passed' ? at(0.96) : null, endedAt: s.state === 'passed' ? at(1) : null },
    ],
  };
};

export const request = <T>() => Promise.resolve(undefined as T);

export const api = {
  tasks: (opts?: { parent?: number }) =>
    opts?.parent !== undefined ? ok({ tasks: f.epicChildren, total: f.epicChildren.length }) : ok({ tasks: [f.task], total: 1 }),
  task: (_id: number) => ok(f.task),
  epic: (_workspaceId: number, _epicRef: number) => ok(f.epic),
  epicStats: (_epicRef: number, _workspaceId: number) => ok(f.epicStats),
  stats: (_from: number, _to: number, _workspaceId?: number) => ok(dashboardStats),
  activity: () => ok({ processes: activityProcesses }),
  workspaceFiles: (_workspaceId: number, path = '', offset = 0) => {
    const entries = FILE_TREE[path] ?? [];
    return ok({ path, entries, total: entries.length, limit: 100, offset });
  },
  workspaceFile: (_workspaceId: number, path: string) => {
    const text = fileText(path);
    return ok({ text, mime: 'text/plain', size: text?.length ?? 0, isBinary: false, isTooLarge: false });
  },
  gitStatus: (_workspaceId: number) => ok({ entries: gitStatusEntries }),
  workspaceRawUrl: (_workspaceId: number, path: string) => `/raw/${path}`,
  timeline: (_workspaceId: number | undefined, from: number, to: number) =>
    ok({ attempts: timelineSpans().filter((s) => s.startedAt <= to && (s.endedAt ?? Date.now()) >= from), from, to }),
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
  taskUsage: (id: number) =>
    ok(f.epicChildUsage[id] ?? { models: {}, agents: {}, toolCalls: {}, totals: null, source: null, cost: null, attemptCount: 0 }),
  taskTimeline: (_id: number) => ok({ events: f.timeline }),
  taskAttemptTimeline: (id: number) => {
    const s = timelineSpans().find((x) => x.taskId === id);
    return s
      ? ok({ attempts: [syntheticAttempt(s)], budgetBase: 0, total: 1 })
      : ok({ attempts: f.attempts });
  },
  taskAttempts: (_id: number) => ok({ attempts: f.runs }),
  config: () => ok(f.config),
  workspaces: () => ok({ workspaces: f.workspaces }),
  attemptLog: (_id: number) => ok({ status: 'available', events: f.attemptLog, liveCursor: 999 }),
  criticLog: (_id: number) => ok({ status: 'available', events: f.criticLog, liveCursor: 999 }),
  attemptGuardrailEvents: (_id: number) => ok({ guardrailEvents: [] }),
  attemptVerificationAttempts: (_id: number) => ok({ verificationAttempts: f.verificationAttempts, verifierStatuses: f.verifierStatuses }),
  attemptDiffFiles: (_id: number) => ok({ files: f.diffFiles }),
  epicDiffFiles: (_workspaceId: number, _epicRef: number) => ok({ files: f.diffFiles }),
  attemptDiff: (_id: number) => ok({ stat: f.task.stat }),
  steerTask: (_id: number, _msg: string) => ok(undefined),
  extendGuardrail: (_id: number, _minutes: number) => ok(f.task),
  conversations: (_workspaceId: number) => ok({ conversations: conversationList }),
  conversation: (_id: number) => ok(conversationDetail),
  conversationEvents: (_id: number) => ok({ events: conversationEventsFixture }),
  permissionRules: () => ok({ rules: permissionRulesFixture }),
  deletePermissionRule: (_id: number) => ok(undefined),
  continuationPreview: (_id: number) => ok({ available: false }),
  epicAttempts: (_workspaceId: number, _epicRef: number) => ok({ attempts: [] }),
} as any;
