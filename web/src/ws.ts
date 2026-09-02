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
import type { FlaggedWorktree } from './flagged-worktrees-model.js';

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

export type ServerMessage =
  | { type: 'attempt_event'; event: AttemptEvent }
  | { type: 'attempt_log_event'; event: AttemptLogEvent }
  | { type: 'attempt_changed'; run: AttemptSummary }
  | { type: 'task_changed'; task: Task }
  | { type: 'attempt_timeline_changed'; taskId: number; attempts: Attempt[]; budgetBase: number }
  // Hard-delete: the Task is gone server-side (Runs/history
  // cascaded); drop it from local state so the board/graph lose it too.
  | { type: 'task_removed'; id: number }
  // Live AttemptSummary usage: the Activity view merges these deltas into its
  // rows so tokens/context/cost tick live. Sent to read keys too.
  | ({ type: 'attempt_usage' } & AttemptUsageEvent)
  | { type: 'operations'; event: OperationEvent }
  | { type: 'scheduled-jobs'; jobs: ScheduledJob[] }
  | { type: 'flagged-worktrees'; flags: FlaggedWorktree[] }
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

function connect(): void {
  if (listeners.size === 0 || ws !== null) return;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/api/ws`);
  ws = socket;
  socket.onopen = () => {
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
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, 1500);
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
    const socket = ws;
    ws = null;
    socket?.close();
  };
}

/** Auto-reconnecting shared subscription to the server's event firehose. */
export function subscribe(onMessage: (msg: ServerMessage) => void): () => void {
  return subscribeWithOpen(onMessage);
}

/** A cursor-resumable subscription to one AttemptSummary's transient ACP transcript. */
export function subscribeAttemptLog({
  attemptId,
  after,
  onEvent,
}: {
  attemptId: number;
  after: () => number;
  onEvent: (event: AttemptLogEvent) => void;
}): () => void {
  let firstSubscription = true;
  return subscribeWithOpen((message) => {
    if (message.type === 'attempt_log_event' && message.event.attemptId === attemptId && message.event.seq > after()) {
      onEvent(message.event);
    }
  }, (socket) => {
    socket.send(JSON.stringify({ type: 'attempt_log_subscribe', attemptId, after: after(), replay: !firstSubscription }));
    firstSubscription = false;
  });
}
