import type { Run, RunEvent, Task } from './types';

export type ServerMessage =
  | { type: 'run_event'; event: RunEvent }
  | { type: 'run_changed'; run: Run }
  | { type: 'task_changed'; task: Task };

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
