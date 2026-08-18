import type {
  Conversation,
  ConversationEvent,
  PermissionAcpRequest,
  Run,
  RunEvent,
  RunUsageEvent,
  Task,
} from './types';

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

/** Auto-reconnecting subscription to the server's event firehose. */
export function subscribe(onMessage: (msg: ServerMessage) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    ws.onmessage = (ev) => onMessage(JSON.parse(String(ev.data)));
    ws.onclose = () => {
      if (!closed) retry = setTimeout(connect, 1500);
    };
  };
  connect();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}
