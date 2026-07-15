import type { Conversation, ConversationEvent, PermissionAcpRequest, Run, RunEvent, Task } from './types';

export type ServerMessage =
  | { type: 'run_event'; event: RunEvent }
  | { type: 'run_changed'; run: Run }
  | { type: 'task_changed'; task: Task }
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
