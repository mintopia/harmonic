/* eslint-disable */
import type { Conversation, ConversationEvent, PermissionRule } from '../types';

const NOW = Date.now();

function conv(over: Partial<Conversation>): Conversation {
  return {
    id: 1,
    title: null,
    workspaceId: 1,
    harness: 'claude',
    model: 'claude-sonnet-4-5',
    workingDir: '/home/workspace/harmonic',
    permissionMode: 'ask',
    state: 'active',
    sessionId: 'sess-1',
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 120_000,
    endedAt: null,
    usage: {
      totals: {
        inputTokens: 18_204,
        outputTokens: 9_120,
        cacheReadTokens: 96_880,
        cacheWriteTokens: 4_336,
        totalTokens: 27_324,
      },
      models: {},
      toolCalls: {},
      source: 'claude',
    },
    cost: { totalUsd: 0.42, byModel: {}, incomplete: false },
    contextTokens: 68_000,
    contextWindow: 200_000,
    cacheWarmSeconds: 300,
    ...over,
  };
}

export const conversationDetail: Conversation = conv({
  id: 1,
  title: 'Wire the diff card into EventStream',
  updatedAt: NOW - 120_000,
});

export const conversationList: Conversation[] = [
  conversationDetail,
  conv({
    id: 2,
    title: 'Investigate flaky merge-race tests',
    harness: 'codex',
    model: 'gpt-5.4',
    updatedAt: NOW - 840_000,
  }),
  conv({
    id: 3,
    title: 'Refactor rail-model view enum',
    updatedAt: NOW - 3_600_000,
  }),
  conv({
    id: 4,
    title: 'OpenCode ACP permissions spike',
    harness: 'opencode',
    model: 'sonnet',
    state: 'ended',
    endedAt: NOW - 10_800_000,
    updatedAt: NOW - 10_800_000,
  }),
  conv({
    id: 5,
    title: 'Baseline schema-sync questions',
    state: 'ended',
    endedAt: NOW - 86_400_000,
    updatedAt: NOW - 86_400_000,
  }),
];

const ev = (id: number, type: ConversationEvent['type'], payload: unknown): ConversationEvent => ({
  id,
  conversationId: 1,
  seq: id,
  ts: NOW - 120_000 + id * 1000,
  type,
  payload,
});

export const conversationEventsFixture: ConversationEvent[] = [
  ev(1, 'user_turn', {
    text: "Wire the diff card into EventStream. Edits should render as a real diff, and degrade to the raw view when there's no diff block. Keep the attempt transcript green.",
  }),
  ev(2, 'session_update', {
    sessionUpdate: 'agent_message_chunk',
    content: {
      text: "The diff block is dropped in `toolContentOutput` — it only keeps `.text`. I'll capture the structured block, render a diff, and fall back to raw when it's absent.",
    },
  }),
  ev(3, 'session_update', {
    sessionUpdate: 'plan',
    entries: [
      { content: 'Read the tool-call model', status: 'completed' },
      { content: 'Capture the diff block in ToolCallView', status: 'completed' },
      { content: 'Render the diff card & raw fallback', status: 'in_progress' },
      { content: 'Regression-test the attempt transcript', status: 'pending' },
    ],
  }),
  ev(4, 'session_update', {
    sessionUpdate: 'tool_call',
    toolCallId: 'r1',
    kind: 'read',
    title: 'src/event-stream-model.ts',
    status: 'completed',
    rawInput: { path: 'src/event-stream-model.ts', lineStart: 21, lineEnd: 32 },
    content: [
      {
        content: {
          text: 'export type ToolCallView = {\n  toolKind: string | undefined;\n  title: string | undefined;\n  status: string | undefined;\n  input: string | null;\n  output: string | null;\n};',
        },
      },
    ],
  }),
  ev(5, 'session_update', {
    sessionUpdate: 'tool_call',
    toolCallId: 'e1',
    kind: 'edit',
    title: 'src/event-stream-model.ts',
    status: 'completed',
    content: [
      {
        type: 'diff',
        path: 'src/event-stream-model.ts',
        oldText: "function toolContentOutput(content) {\n  return blocks.map((b) => b.text).join('');\n}\n",
        newText:
          "function toolContentOutput(content) {\n  return blocks.flatMap(pickTextOrDiff).join('');\n  // diff blocks (path/oldText/newText) now survive\n}\n",
      },
    ],
  }),
  ev(6, 'session_update', {
    sessionUpdate: 'tool_call',
    toolCallId: 'x1',
    kind: 'execute',
    title: 'npm run test:web -- event-stream',
    status: 'completed',
    rawInput: { command: 'npm run test:web -- event-stream' },
    content: [
      {
        content: {
          text: ' ✓ event-stream-model.test.ts (24)\n ✓ conversation-transcript-model.test.ts (11)\n Test Files  2 passed · Tests  35 passed',
        },
      },
    ],
  }),
  ev(7, 'session_update', {
    sessionUpdate: 'tool_call',
    toolCallId: 's1',
    kind: 'search',
    title: 'Searched toolContentOutput — 6 matches in 3 files',
    status: 'completed',
  }),
  ev(8, 'session_update', {
    sessionUpdate: 'agent_thought_chunk',
    content: {
      text: 'The block arrives as an ACP diff content type carrying path, oldText, newText. I can build a unified diff from that pair without touching the harness.',
    },
  }),
  ev(9, 'session_update', {
    sessionUpdate: 'tool_call',
    toolCallId: 'e2',
    kind: 'edit',
    title: 'web/src/components/conversation/Transcript.tsx',
    status: 'in_progress',
  }),
];

export const permissionRulesFixture: PermissionRule[] = [
  { id: 1, kind: 'edit', workingDir: '/home/workspace/harmonic', createdAt: NOW },
  { id: 2, kind: 'run', workingDir: '/home/workspace/harmonic', createdAt: NOW },
];
