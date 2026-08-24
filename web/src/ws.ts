import type {
  Conversation,
  ConversationEvent,
  PermissionAcpRequest,
  Run,
  RunEvent,
  RunUsageEvent,
  Task,
} from './types.js';

export type ServerMessage =
  | { type: 'run_event'; event: RunEvent }
  | { type: 'run_changed'; run: Run }
  | { type: 'task_changed'; task: Task }
  // Hard-delete (issue #162): the Task is gone server-side (Runs/history
  // cascaded); drop it from local state so the board/graph lose it too.
  | { type: 'task_removed'; id: number }
  // Live Run usage (ADR 0010): the Activity view merges these deltas into its
  // rows so tokens/context/cost tick live. Sent to read keys too.
  | ({ type: 'run_usage' } & RunUsageEvent)
  | { type: 'conversation_event'; event: ConversationEvent }
  | { type: 'conversation_changed'; conversation: Conversation }
  // Issue #11: the Harness is blocked on this ACP permission request until
  // the operator answers (POST .../permissions/:reqId) or the conversation
  // ends/crashes — the panel clears it on a matching resolved
  // `conversation_event` (payload.reqId) or on conversation end.
  | { type: 'permission_request'; conversationId: number; reqId: string; request: PermissionAcpRequest };

const listeners = new Set<{ onMessage: (msg: ServerMessage) => void }>();
let ws: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;

function connect(): void {
  if (listeners.size === 0 || ws !== null) return;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/api/ws`);
  ws = socket;
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

/** Auto-reconnecting shared subscription to the server's event firehose. */
export function subscribe(onMessage: (msg: ServerMessage) => void): () => void {
  const listener = { onMessage };
  let subscribed = true;
  listeners.add(listener);
  connect();

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
