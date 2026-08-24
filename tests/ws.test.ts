/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '../web/src/ws.js';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly url: string;
  readonly OPEN = FakeWebSocket.OPEN;
  readonly CLOSED = FakeWebSocket.CLOSED;
  readyState = FakeWebSocket.OPEN;
  closeCalls = 0;
  sent: unknown[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  emit(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  close() {
    this.closeCalls += 1;
    this.readyState = this.CLOSED;
  }

  send(message: string) {
    this.sent.push(JSON.parse(message));
  }

  serverClose() {
    this.readyState = this.CLOSED;
    this.onclose?.();
  }
}

async function loadSubscribe() {
  vi.resetModules();
  const mod = await import('../web/src/ws.js');
  return mod.subscribe;
}

async function loadSubscribeRunLog() {
  vi.resetModules();
  const mod = await import('../web/src/ws.js');
  return mod.subscribeRunLog;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe('subscribe', () => {
  it('shares one physical websocket across listeners and fans events out', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const subscribe = await loadSubscribe();
    const left: ServerMessage[] = [];
    const right: ServerMessage[] = [];

    const unsubscribeLeft = subscribe((message) => left.push(message));
    const unsubscribeRight = subscribe((message) => right.push(message));

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toMatch(/\/api\/ws$/);

    const socket = FakeWebSocket.instances[0]!;
    const first = { type: 'task_removed', id: 7 } satisfies ServerMessage;
    socket.emit(first);
    expect(left).toEqual([first]);
    expect(right).toEqual([first]);

    unsubscribeLeft();
    expect(socket.closeCalls).toBe(0);

    const second = { type: 'task_removed', id: 8 } satisfies ServerMessage;
    socket.emit(second);
    expect(left).toEqual([first]);
    expect(right).toEqual([first, second]);

    unsubscribeRight();
    expect(socket.closeCalls).toBe(1);
  });

  it('uses one shared reconnect path and clears it on final unsubscribe', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const subscribe = await loadSubscribe();
    const left: ServerMessage[] = [];
    const right: ServerMessage[] = [];

    const unsubscribeLeft = subscribe((message) => left.push(message));
    const unsubscribeRight = subscribe((message) => right.push(message));

    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.serverClose();
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1_500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);

    const reconnectedSocket = FakeWebSocket.instances[1]!;
    const first = { type: 'task_removed', id: 9 } satisfies ServerMessage;
    reconnectedSocket.emit(first);
    expect(left).toEqual([first]);
    expect(right).toEqual([first]);

    unsubscribeLeft();
    reconnectedSocket.serverClose();
    expect(vi.getTimerCount()).toBe(1);

    unsubscribeRight();
    expect(reconnectedSocket.closeCalls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(1_500);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe('subscribeRunLog', () => {
  it('starts live-only, then replays from its cursor after reconnecting', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const subscribeRunLog = await loadSubscribeRunLog();

    const unsubscribe = subscribeRunLog({ runId: 42, after: () => 7, onEvent: () => {} });
    expect(FakeWebSocket.instances[0]?.sent).toEqual([{ type: 'run_log_subscribe', runId: 42, after: 7, replay: false }]);

    FakeWebSocket.instances[0]?.serverClose();
    vi.advanceTimersByTime(1_500);
    FakeWebSocket.instances[1]?.onopen?.();
    expect(FakeWebSocket.instances[1]?.sent).toEqual([{ type: 'run_log_subscribe', runId: 42, after: 7, replay: true }]);

    unsubscribe();
  });
});
