/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '../web/src/ws.js';
import type { AttemptLogEvent } from '../web/src/types.js';

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
  return mod.subscribeAttemptLog;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

  it('runs each subscriber onReopen exactly once per reconnect, never on the first open', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const subscribe = await loadSubscribe();

    let reloadsA = 0;
    let reloadsB = 0;
    const unsubscribeA = subscribe(
      () => {},
      () => {
        reloadsA += 1;
      },
    );
    const unsubscribeB = subscribe(
      () => {},
      () => {
        reloadsB += 1;
      },
    );

    expect(reloadsA).toBe(0);
    expect(reloadsB).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(1);

    for (let reconnect = 1; reconnect <= 3; reconnect += 1) {
      FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!.serverClose();
      vi.advanceTimersByTime(1);
      FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!.onopen?.();
      expect(reloadsA).toBe(reconnect);
      expect(reloadsB).toBe(reconnect);
    }

    unsubscribeA();
    unsubscribeB();
  });

  it('replays an outstanding permission request to a late subscriber', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const subscribe = await loadSubscribe();
    const first: ServerMessage[] = [];
    const second: ServerMessage[] = [];
    const unsubscribeFirst = subscribe((message) => first.push(message));
    const permission = {
      type: 'permission_request',
      conversationId: 7,
      reqId: 'perm-1',
      request: { sessionId: 'session-1', toolCall: {}, options: [] },
    } satisfies ServerMessage;

    FakeWebSocket.instances[0]!.emit(permission);
    const unsubscribeSecond = subscribe((message) => second.push(message));

    expect(first).toEqual([permission]);
    expect(second).toEqual([permission]);

    unsubscribeFirst();
    unsubscribeSecond();
  });

  it('does not replay permissions that were resolved or whose conversation ended', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const subscribe = await loadSubscribe();
    const unsubscribeFirst = subscribe(() => {});
    const socket = FakeWebSocket.instances[0]!;
    const permission = (reqId: string, conversationId = 7) =>
      ({
        type: 'permission_request',
        conversationId,
        reqId,
        request: { sessionId: 'session-1', toolCall: {}, options: [] },
      }) satisfies ServerMessage;

    socket.emit(permission('perm-resolved'));
    socket.emit({
      type: 'conversation_event',
      event: {
        id: 1,
        conversationId: 7,
        seq: 1,
        ts: 1,
        type: 'permission_request',
        payload: { reqId: 'perm-resolved' },
      },
    } satisfies ServerMessage);
    socket.emit(permission('perm-ended'));
    socket.emit({
      type: 'conversation_changed',
      conversation: {
        id: 7,
        title: null,
        workspaceId: 1,
        harness: 'codex',
        model: 'gpt-5.6-sol',
        workingDir: '/workspace',
        permissionMode: 'ask',
        state: 'ended',
        sessionId: null,
        createdAt: 1,
        updatedAt: 1,
        endedAt: 1,
        usage: null,
        cost: null,
        contextTokens: null,
        contextWindow: null,
        cacheWarmSeconds: null,
      },
    } satisfies ServerMessage);

    const replayed: ServerMessage[] = [];
    const unsubscribeSecond = subscribe((message) => replayed.push(message));

    expect(replayed).toEqual([]);

    unsubscribeFirst();
    unsubscribeSecond();
  });

  it('clears cached permissions when the shared socket closes', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const subscribe = await loadSubscribe();
    const unsubscribeFirst = subscribe(() => {});
    const permission = {
      type: 'permission_request',
      conversationId: 7,
      reqId: 'perm-1',
      request: { sessionId: 'session-1', toolCall: {}, options: [] },
    } satisfies ServerMessage;

    FakeWebSocket.instances[0]!.emit(permission);
    FakeWebSocket.instances[0]!.serverClose();
    const replayed: ServerMessage[] = [];
    const unsubscribeSecond = subscribe((message) => replayed.push(message));

    expect(replayed).toEqual([]);

    unsubscribeFirst();
    unsubscribeSecond();
  });

  it('backs off with a full-jitter exponential schedule, caps at 30s, and resets on open', async () => {
    vi.useFakeTimers();
    const r = 0.5;
    vi.spyOn(Math, 'random').mockReturnValue(r);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const subscribe = await loadSubscribe();

    const oracle = (attempt: number) => r * Math.min(30_000, 1_000 * 2 ** attempt);
    const unsubscribe = subscribe(() => {});

    let live = 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      FakeWebSocket.instances[live]!.serverClose();
      const delay = oracle(attempt);
      vi.advanceTimersByTime(delay - 1);
      expect(FakeWebSocket.instances).toHaveLength(live + 1);
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances).toHaveLength(live + 2);
      live += 1;
    }

    FakeWebSocket.instances[live]!.onopen?.();
    FakeWebSocket.instances[live]!.serverClose();
    vi.advanceTimersByTime(oracle(0) - 1);
    expect(FakeWebSocket.instances).toHaveLength(live + 1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(live + 2);

    unsubscribe();
  });

  it('cancels the reconnect timer on final unsubscribe (no leak)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const subscribe = await loadSubscribe();

    const unsubscribe = subscribe(() => {});
    FakeWebSocket.instances[0]!.serverClose();
    expect(vi.getTimerCount()).toBe(1);

    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('subscribeAttemptLog', () => {
  it('starts live-only, then replays from its cursor after reconnecting', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const subscribeAttemptLog = await loadSubscribeRunLog();

    const unsubscribe = subscribeAttemptLog({ attemptId: 42, after: () => 7, onEvent: () => {} });
    expect(FakeWebSocket.instances[0]?.sent).toEqual([{ type: 'attempt_log_subscribe', attemptId: 42, after: 7, replay: false }]);

    FakeWebSocket.instances[0]?.serverClose();
    vi.advanceTimersByTime(1_500);
    FakeWebSocket.instances[1]?.onopen?.();
    expect(FakeWebSocket.instances[1]?.sent).toEqual([{ type: 'attempt_log_subscribe', attemptId: 42, after: 7, replay: true }]);

    unsubscribe();
  });
});

describe('subscribeCriticLog', () => {
  it('replays from its own channel on the first open and forwards only critic_log events', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.resetModules();
    const { subscribeCriticLog } = await import('../web/src/ws.js');
    const seen: AttemptLogEvent[] = [];

    const unsubscribe = subscribeCriticLog({ attemptId: 42, after: () => 0, onEvent: (event) => seen.push(event) });
    // No REST snapshot backs the critic channel, so it replays from its buffer on the first open.
    expect(FakeWebSocket.instances[0]?.sent).toEqual([{ type: 'critic_log_subscribe', attemptId: 42, after: 0, replay: true }]);

    const socket = FakeWebSocket.instances[0]!;
    const criticEvent: AttemptLogEvent = { id: 1, attemptId: 42, seq: 1, ts: 1, type: 'session_update', payload: { sessionUpdate: 'agent_message_chunk' } };
    // A same-id builder event on the other channel must not reach a critic subscriber.
    socket.emit({ type: 'attempt_log_event', event: { id: 9, attemptId: 42, seq: 2, ts: 2, type: 'session_update', payload: { sessionUpdate: 'agent_message_chunk' } } });
    socket.emit({ type: 'critic_log_event', event: criticEvent });
    expect(seen).toEqual([criticEvent]);

    unsubscribe();
  });
});
