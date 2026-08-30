/* eslint-disable */
// Fixture data for the Epic-393 TicketPage story harness. Shaped to match the
// design canvas (Stats/Attempt/Timeline/Diff artboards). Cast `as any` freely —
// the story build strips types and only runtime-read fields matter.

const T0 = Date.parse('2026-08-29T14:02:00Z');
const min = (n: number) => n * 60_000;

const opusUsage = { inputTokens: 486_000, outputTokens: 62_000, cacheReadTokens: 2_900_000, cacheWriteTokens: 411_000 };
const sonnetUsage = { inputTokens: 202_000, outputTokens: 28_000, cacheReadTokens: 830_000, cacheWriteTokens: 129_000 };
const rootAgent = { inputTokens: 486_000, outputTokens: 62_000, cacheReadTokens: 2_400_000, cacheWriteTokens: 350_000 };
const subAgent = { inputTokens: 120_000, outputTokens: 16_000, cacheReadTokens: 420_000, cacheWriteTokens: 66_000 };
const subAgent2 = { inputTokens: 82_000, outputTokens: 12_000, cacheReadTokens: 280_000, cacheWriteTokens: 44_000 };

const usage3 = {
  totals: { inputTokens: 688_000, outputTokens: 90_000, cacheReadTokens: 3_730_000, cacheWriteTokens: 540_000, totalTokens: 5_048_000 },
  models: { 'opus-4.8': opusUsage, 'sonnet-4.5': sonnetUsage },
  agents: { root: rootAgent, 'subagent:reviewer': subAgent, 'subagent:tester': subAgent2 },
  toolCalls: { Edit: 40, Bash: 23, Read: 105 },
  source: 'session-log',
};

const cost3 = {
  totalUsd: 17.82,
  byModel: { 'opus-4.8': 14.72, 'sonnet-4.5': 2.14, critic: 0.96 },
  incomplete: false,
};

const workspace = {
  id: 1,
  name: 'harmonic-core',
  workingDir: '/home/workspace/harmonic',
  maxAttempts: 6,
  isolationMode: 'worktree',
} as any;

export const task = {
  id: 172,
  prompt:
    'Surface the per-workspace guardrail ceilings (max attempts, token budget, wall-clock cap) as editable `global defaults` in Settings, so an operator can set fleet-wide limits once instead of per task. New workspaces inherit the defaults; a task may still override. Includes the `SettingsPage` form, the config plumbing, and a migration test.\n\nThe defaults live on `WorkspaceConfig` and resolve through `resolveGuardrails`. A task-level override still wins where present.',
  summary: 'Expose global Attempt guardrail defaults',
  workspaceId: 1,
  harness: 'claude',
  model: 'opus-4.8',
  workingDir: '/home/workspace/harmonic',
  isolationMode: 'worktree',
  baseBranch: 'develop',
  priority: 'normal',
  conflictResolveTurns: 3,
  overrides: {},
  state: 'escalated',
  escalationReason: 'escalated to human: review gates the merge — verified head ready.',
  feedback: null,
  createdAt: T0,
  updatedAt: T0 + min(90),
  dependsOn: [168, 171],
  dependents: [],
  blockedOnFailed: false,
  openBlockerCount: 0,
  agentWorkable: false,
  humanOnly: false,
  cost: cost3,
  origin: 'mirrored',
  trackerRef: 185,
  workflow: 'implement',
  wayfinderType: null,
  mapRef: 166,
  url: null,
  mapTitle: null,
  branch: 'harmonic/task-172',
  stat: [
    ' src/config.ts                    | 54 ++++++++++------',
    ' web/src/components/TicketPage.tsx | 130 ++++++------',
    ' tests/guardrail-defaults.test.ts | 32 ++++++++',
    ' src/db/schema.ts                 | 22 ++++++',
    ' web/src/openapi.json             | 14 ------',
  ].join('\n'),
  runStartedAt: null,
  toolCount: null,
  attemptId: null,
  currentStep: null,
  contextTokens: null,
  contextWindow: null,
  verifiedRef: 'e33b4ae',
  skipReason: null,
  priority_: undefined,
} as any;

// AttemptSummary rows (GET /api/tasks/:id/attempts)
export const runs = [
  { id: 501, taskId: 172, number: 1, state: 'failed', reason: 'pnpm test failed — 2 assertions in guardrail-defaults.test.ts.', stopReason: null, sessionId: '01H9ABC1', prompt: null, branch: 'harmonic/task-172', baseBranch: 'develop', usage: null, cost: null, toolCalls: 52, startedAt: T0 + min(3), finishedAt: T0 + min(18) },
  { id: 502, taskId: 172, number: 2, state: 'failed', reason: 'Critic blocked — defaults leaked into per-task overrides.', stopReason: null, sessionId: '01H9ABC2', prompt: null, branch: 'harmonic/task-172', baseBranch: 'develop', usage: null, cost: null, toolCalls: 53, startedAt: T0 + min(20), finishedAt: T0 + min(29) },
  { id: 503, taskId: 172, number: 3, state: 'completed', reason: null, stopReason: null, sessionId: '01H9…4RT2', prompt: null, branch: 'harmonic/task-172', baseBranch: 'develop', usage: usage3, cost: cost3, toolCalls: 63, startedAt: T0 + min(31), finishedAt: T0 + min(90) },
] as any;

const steps3 = [
  { id: 1, attemptId: 503, type: 'rebase', position: 0, state: 'passed', command: null, verdict: null, logLocator: null, startedAt: T0 + min(31), endedAt: T0 + min(32) },
  { id: 2, attemptId: 503, type: 'implementation', position: 1, state: 'passed', command: null, verdict: null, logLocator: null, startedAt: T0 + min(32), endedAt: T0 + min(80) },
  { id: 3, attemptId: 503, type: 'verification', position: 2, state: 'passed', command: 'pnpm test', verdict: null, logLocator: null, startedAt: T0 + min(80), endedAt: T0 + min(85) },
  { id: 4, attemptId: 503, type: 'review', position: 3, state: 'passed', command: null, verdict: null, logLocator: null, startedAt: T0 + min(85), endedAt: T0 + min(89) },
];

// Attempt (timeline, step-bearing) rows (GET /api/tasks/:id/attempt-timeline)
export const attempts = [
  { id: 501, taskId: 172, number: 1, state: 'failed', startedAt: T0 + min(3), endedAt: T0 + min(18), feedback: '2 assertions failed', verifiedSha: null, escalationReason: null, verifierStatuses: [], continuation: null, steps: [] },
  { id: 502, taskId: 172, number: 2, state: 'failed', startedAt: T0 + min(20), endedAt: T0 + min(29), feedback: 'defaults leaked', verifiedSha: null, escalationReason: null, verifierStatuses: [], continuation: null, steps: [] },
  { id: 503, taskId: 172, number: 3, state: 'passed', startedAt: T0 + min(31), endedAt: T0 + min(90), feedback: null, verifiedSha: 'e33b4ae', escalationReason: null, verifierStatuses: [], continuation: { path: 'continued-session' }, steps: steps3 },
] as any;

// Transcript for attempt 3 (GET /api/attempts/:id/log)
export const attemptLog = [
  { id: 1, seq: 1, ts: T0 + min(32), type: 'session_update', payload: { sessionUpdate: 'agent_message_chunk', content: { text: "The guardrail ceilings live in `config.ts` as workspace fields. Here's the **plan**:\n\n1. Add a `GUARDRAIL_DEFAULTS` block to `config.ts`\n2. Wire the `SettingsPage` form to it\n3. Have workspace creation *inherit* it\n\n```ts\nexport const GUARDRAIL_DEFAULTS = { maxAttempts: 6, tokenBudget: null };\n```\n\nA task-level override still wins where present." } } },
  { id: 2, seq: 2, ts: T0 + min(33), type: 'session_update', payload: { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'edit', title: 'Edit src/config.ts', status: 'completed' } },
  { id: 3, seq: 3, ts: T0 + min(60), type: 'session_update', payload: { sessionUpdate: 'tool_call', toolCallId: 't2', kind: 'execute', title: 'Bash pnpm test guardrail-defaults', status: 'completed', content: [{ content: { text: 'Test Files  1 passed (1)\n     Tests  12 passed (12)\n  Duration  3.41s' } }] } },
  { id: 4, seq: 4, ts: T0 + min(88), type: 'session_update', payload: { sessionUpdate: 'operator_message', content: { text: 'Also regenerate openapi.json and add a migration test before you wrap up.' } } },
  { id: 5, seq: 5, ts: T0 + min(89), type: 'session_update', payload: { sessionUpdate: 'agent_message_chunk', content: { text: 'On it — regenerated the OpenAPI schema and added guardrail-defaults.test.ts. All 12 tests pass and the per-task override still wins. Handing to verification.' } } },
] as any;

export const timeline = [
  { attemptId: null, ts: T0, kind: 'fact', data: { type: 'task-created', trackerRef: '185', workspace: 'harmonic-core' } },
  { attemptId: 501, ts: T0 + min(0), kind: 'attempt-started', data: { attempt: 1 } },
  { attemptId: 501, ts: T0 + min(18), kind: 'attempt-finished', data: { attempt: 1, state: 'failed' } },
  { attemptId: 502, ts: T0 + min(20), kind: 'attempt-started', data: { attempt: 2 } },
  { attemptId: 502, ts: T0 + min(29), kind: 'attempt-finished', data: { attempt: 2, state: 'failed' } },
  { attemptId: 503, ts: T0 + min(31), kind: 'attempt-started', data: { attempt: 3 } },
  { attemptId: 503, ts: T0 + min(85), kind: 'verification', data: { verdict: 'pass', summary: 'defaults and overrides behave as specified', mechanism: 'critic' } },
  { attemptId: 503, ts: T0 + min(89), kind: 'attempt-finished', data: { attempt: 3, state: 'passed' } },
  { attemptId: null, ts: T0 + min(90), kind: 'escalation', data: {} },
] as any;

export const diffFiles = [
  {
    path: 'src/config.ts',
    status: 'M',
    additions: 48,
    deletions: 6,
    lines: [
      { kind: 'hunk', oldLn: null, newLn: null, text: '@@ -18,7 +18,9 @@ export interface WorkspaceConfig {' },
      { kind: 'context', oldLn: 18, newLn: 18, text: '  /** Per-workspace guardrail ceilings. */' },
      { kind: 'context', oldLn: 19, newLn: 19, text: '  maxAttempts: number;' },
      { kind: 'del', oldLn: 20, newLn: null, text: '  tokenBudget: number;' },
      { kind: 'add', oldLn: null, newLn: 20, text: '  tokenBudget: number | null;' },
      { kind: 'add', oldLn: null, newLn: 21, text: '  wallClockCapMs: number | null;' },
      { kind: 'context', oldLn: 21, newLn: 22, text: '}' },
      { kind: 'hunk', oldLn: null, newLn: null, text: '@@ -44,6 +46,24 @@ export const DEFAULT_TASK_PROMPT = ...' },
      { kind: 'add', oldLn: null, newLn: 49, text: 'export const GUARDRAIL_DEFAULTS = {' },
      { kind: 'add', oldLn: null, newLn: 50, text: '  maxAttempts: 6,' },
      { kind: 'add', oldLn: null, newLn: 51, text: '  tokenBudget: null,' },
      { kind: 'add', oldLn: null, newLn: 52, text: '} as const;' },
    ],
  },
] as any;

export const verifierStatuses = [
  { mechanism: 'command', state: 'passed', reason: null, commands: ['pnpm test'] },
  { mechanism: 'critic', state: 'passed', reason: null },
] as any;

export const verificationAttempts = [
  { id: 9001, attemptId: 503, seq: 1, ts: T0 + min(84), mechanism: 'command', inputOid: 'e33b4ae', verdict: 'pass', summary: 'pnpm test · 12 passed, 0 failed', output: 'Test Files 1 passed (1)\nTests 12 passed (12)', hasTranscript: false },
  { id: 9002, attemptId: 503, seq: 2, ts: T0 + min(88), mechanism: 'critic', inputOid: 'e33b4ae', verdict: 'pass', summary: 'Verdict proceed — defaults and overrides behave as specified.', output: '', hasTranscript: true },
] as any;

export const config = { maxAttempts: 6 } as any;
export const workspaces = [workspace];
