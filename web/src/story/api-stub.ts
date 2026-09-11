/* eslint-disable */
import * as f from './fixtures';
import { conversationDetail, conversationEventsFixture, conversationList, permissionRulesFixture } from './conversation-fixtures';

const ok = <T>(v: T) => Promise.resolve(v);

const H = 3600_000;
const cost = (model: string, usd: number) => ({ totalUsd: usd, byModel: { [model]: usd }, incomplete: false });
/** Fleet-Timeline spans relative to `to` (now): three harness lanes, every
 * outcome, two live runs and an overlap that forces a codex sub-row. Finished
 * runs carry a frozen Cost; running ones have none yet (honest floor). */
const timelineSpans = (to: number) => {
  const t = (hoursAgo: number) => Math.round(to - hoursAgo * H);
  const base = [
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
  return base.map((s) => ({ ...s, cost: s.endedAt ? cost(s.model, Math.round((0.18 + (s.attemptId % 5) * 0.27) * 100) / 100) : null }));
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
  stats: (_from: number, _to: number, _workspaceId: number) => ok(f.statsFixture),
  timeline: (_workspaceId: number, from: number, to: number) => ok({ attempts: timelineSpans(to), from, to }),
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
    const s = timelineSpans(Date.now()).find((x) => x.taskId === id);
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
  conversations: (_workspaceId: number) => ok({ conversations: conversationList }),
  conversation: (_id: number) => ok(conversationDetail),
  conversationEvents: (_id: number) => ok({ events: conversationEventsFixture }),
  permissionRules: () => ok({ rules: permissionRulesFixture }),
  deletePermissionRule: (_id: number) => ok(undefined),
  continuationPreview: (_id: number) => ok({ available: false }),
  epicAttempts: (_workspaceId: number, _epicRef: number) => ok({ attempts: [] }),
} as any;
