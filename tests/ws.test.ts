/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '../web/src/ws.js';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = this.OPEN;
  closeCalls = 0;
  onmessage: ((event: { data: string }) => void) | null = null;
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
