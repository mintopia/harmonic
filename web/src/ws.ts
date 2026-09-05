import type {
  Attempt,
  Conversation,
  ConversationEvent,
  PermissionAcpRequest,
  AttemptSummary,
  AttemptEvent,
  AttemptLogEvent,
  AttemptUsageEvent,
  Task,
} from './types.js';
import type { ScheduledJob } from './scheduled-jobs-model.js';
import type { WorktreeInventoryEntry } from './worktree-inventory-model.js';

export interface OperationEvent {
  type: 'op-started' | 'op-updated' | 'op-ended';
  operation: {
    type: string;
    name: string;
    traceId: string;
    spanId: string;
    parentSpanId: string | null;
    attributes: Record<string, unknown>;
    startedAt: number;
    endedAt: number | null;
    status: { code: number; message: string | null };
    children: OperationEvent['operation'][];
  };
}

/** The host OS's 1/5/15-minute load averages, its CPU core count, and whether
 * it is saturated (the server's hysteresis state, which drives the header tint). */
export interface HostLoad {
  load1: number;
  load5: number;
  load15: number;
  cores: number;
  saturated: boolean;
}

export type ServerMessage =
  | { type: 'attempt_event'; event: AttemptEvent }
  | { type: 'attempt_log_event'; event: AttemptLogEvent }
  | { type: 'critic_log_event'; event: AttemptLogEvent }
  | { type: 'attempt_changed'; run: AttemptSummary }
  | { type: 'task_changed'; task: Task }
  | { type: 'attempt_timeline_changed'; taskId: number; attempts: Attempt[]; budgetBase: number }
  // Hard-delete: the Task is gone server-side (Attempts/history
  // cascaded); drop it from local state so the board/graph lose it too.
  | { type: 'task_removed'; id: number }
  // An Epic's integration merge advanced a step; the board refetches its epics
  // so the merge progress follows live (Epics carry no Attempt stream).
  | { type: 'epic_changed'; workspaceId: number; epicRef: number }
  // Live AttemptSummary usage: the Activity view merges these deltas into its
  // rows so tokens/context/cost tick live. Sent to read keys too.
  | ({ type: 'attempt_usage' } & AttemptUsageEvent)
  | { type: 'operations'; event: OperationEvent }
  | { type: 'scheduled-jobs'; jobs: ScheduledJob[] }
  | { type: 'worktrees'; worktrees: WorktreeInventoryEntry[] }
  // Host load-average reading, pushed on a fixed tick and once on connect. Sent to read keys too.
  | { type: 'host_load'; load: HostLoad }
  | { type: 'conversation_event'; event: ConversationEvent }
  | { type: 'conversation_changed'; conversation: Conversation }
  // The Harness is blocked on this ACP permission request until
  // the operator answers (POST .../permissions/:reqId) or the conversation
  // ends/crashes — the panel clears it on a matching resolved
  // `conversation_event` (payload.reqId) or on conversation end.
  | { type: 'permission_request'; conversationId: number; reqId: string; request: PermissionAcpRequest };

const listeners = new Set<{
  onMessage: (msg: ServerMessage) => void;
  onOpen?: (socket: WebSocket) => void;
}>();
let ws: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;

const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
let consecutiveFailedOpens = 0;

function fullJitterBackoffMs(attempt: number): number {
  const ceiling = Math.min(MAX_RETRY_MS, INITIAL_RETRY_MS * 2 ** attempt);
  return Math.random() * ceiling;
}

function connect(): void {
  if (listeners.size === 0 || ws !== null) return;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/api/ws`);
  ws = socket;
  socket.onopen = () => {
    consecutiveFailedOpens = 0;
    for (const listener of listeners) listener.onOpen?.(socket);
  };
  socket.onmessage = (ev) => {
    const message: ServerMessage = JSON.parse(String(ev.data));
    for (const listener of listeners) listener.onMessage(message);
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    if (listeners.size > 0 && retry === null) {
      const delay = fullJitterBackoffMs(consecutiveFailedOpens);
      consecutiveFailedOpens += 1;
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, delay);
    }
  };
}

function subscribeWithOpen(onMessage: (msg: ServerMessage) => void, onOpen?: (socket: WebSocket) => void): () => void {
  const listener = onOpen ? { onMessage, onOpen } : { onMessage };
  let subscribed = true;
  listeners.add(listener);
  connect();
  if (ws?.readyState === WebSocket.OPEN) onOpen?.(ws);

  return () => {
    if (!subscribed) return;
    subscribed = false;
    listeners.delete(listener);
    if (listeners.size > 0) return;

    if (retry !== null) {
      clearTimeout(retry);
      retry = null;
    }
    consecutiveFailedOpens = 0;
    const socket = ws;
    ws = null;
    socket?.close();
  };
}

/**
 * Auto-reconnecting shared subscription to the server's event firehose.
 * `onReopen` runs once per *reconnect* — not the first open — so pass a
 * subscriber's `load()` to re-hydrate after a drop. Do the initial hydrate on
 * mount as usual; the first open is already covered by it.
 */
export function subscribe(onMessage: (msg: ServerMessage) => void, onReopen?: () => void): () => void {
  let opened = false;
  return subscribeWithOpen(
    onMessage,
    onReopen
      ? () => {
          if (opened) onReopen();
          else opened = true;
        }
      : undefined,
  );
}

function subscribeLog(
  channel: 'attempt_log_event' | 'critic_log_event',
  subscribe: 'attempt_log_subscribe' | 'critic_log_subscribe',
  { attemptId, after, onEvent }: { attemptId: number; after: () => number; onEvent: (event: AttemptLogEvent) => void },
  // The attempt log hydrates its history from REST, so it skips the first
  // replay; the critic channel has no REST snapshot, so it replays the buffer.
  replayOnFirstOpen: boolean,
): () => void {
  let firstSubscription = true;
  return subscribeWithOpen((message) => {
    if (message.type === channel && message.event.attemptId === attemptId && message.event.seq > after()) {
      onEvent(message.event);
    }
  }, (socket) => {
    socket.send(JSON.stringify({ type: subscribe, attemptId, after: after(), replay: replayOnFirstOpen || !firstSubscription }));
    firstSubscription = false;
  });
}

/** A cursor-resumable subscription to one AttemptSummary's transient ACP transcript. */
export function subscribeAttemptLog(args: { attemptId: number; after: () => number; onEvent: (event: AttemptLogEvent) => void }): () => void {
  return subscribeLog('attempt_log_event', 'attempt_log_subscribe', args, false);
}

/** A cursor-resumable subscription to a running critic's own live ACP transcript
 * — its own channel, keyed by the builder Attempt id. */
export function subscribeCriticLog(args: { attemptId: number; after: () => number; onEvent: (event: AttemptLogEvent) => void }): () => void {
  return subscribeLog('critic_log_event', 'critic_log_subscribe', args, true);
}
