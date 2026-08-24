import { afterEach, describe, expect, it } from 'vitest';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { initializeTelemetry, resolveTelemetryOptions, type TelemetryController } from '../src/telemetry.js';
import type { OperationEvent } from '../src/telemetry/operations.js';
import { startOperation } from '../src/telemetry/operations.js';
import { startServer, waitFor, type TestServer } from './helpers.js';

describe('Operations API (issue #293)', () => {
  let server: TestServer | undefined;
  let telemetry: TelemetryController | undefined;

  afterEach(async () => {
    await server?.close();
    await telemetry?.shutdown();
    trace.disable();
    server = undefined;
    telemetry = undefined;
  });

  it('returns the live operation tree and bounded completed-root history', async () => {
    telemetry = initializeTelemetry(resolveTelemetryOptions({ exportEnabled: 'false' }));
    server = await startServer();

    const live = startOperation({ type: 'poll', attributes: { 'tracker.name': 'github' } });
    const child = live.run(() => startOperation({ type: 'fetch', attributes: {} }));
    const during = await server.api('GET', '/api/operations');
    expect(during.status).toBe(200);
    expect(during.body.operations).toEqual([
      expect.objectContaining({
        type: 'poll',
        attributes: expect.objectContaining({ 'tracker.name': 'github' }),
        children: [expect.objectContaining({ type: 'fetch' })],
      }),
    ]);
    expect(during.body.recent).toEqual([]);

    child.end();
    live.end();
    const completed = await server.api('GET', '/api/operations');
    expect(completed.body.operations).toEqual([]);
    expect(completed.body.recent).toEqual([
      expect.objectContaining({ type: 'poll', endedAt: expect.any(Number) }),
    ]);
    const readKey = await server.api('POST', '/api/keys', { name: 'operations-snapshot', scope: 'read' });
    const readResponse = await fetch(`${server.baseUrl}/api/operations`, {
      headers: { authorization: `Bearer ${readKey.body.token}` },
    });
    expect(readResponse.status).toBe(200);
  });

  it('streams operation events to full and read-scoped firehose clients', async () => {
    telemetry = initializeTelemetry(resolveTelemetryOptions({ exportEnabled: 'false' }));
    server = await startServer();
    const readKey = await server.api('POST', '/api/keys', { name: 'operations-viz', scope: 'read' });
    const fullWs = new WebSocket(`${server.baseUrl.replace('http', 'ws')}/api/ws?token=${server.sessionToken}`);
    const readWs = new WebSocket(`${server.baseUrl.replace('http', 'ws')}/api/ws?token=${readKey.body.token}`);
    const fullMessages: unknown[] = [];
    const messages: unknown[] = [];
    fullWs.addEventListener('message', (event) => fullMessages.push(JSON.parse(String(event.data))));
    readWs.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))));
    await Promise.all([fullWs, readWs].map((ws) => new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('WebSocket failed to open')));
    })));

    const operationEvent: OperationEvent = {
      type: 'op-started',
      operation: {
        type: 'poll',
        name: 'harmonic.poll',
        spanContext: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1, isRemote: false },
        parentSpanContext: undefined,
        attributes: {},
        startedAt: 1,
        status: { code: SpanStatusCode.UNSET },
      },
    };
    server.app.ctx.bus.emit('operations', operationEvent);
    const streamed = await waitFor(async () => {
      const candidate = messages.find(
        (message): message is { type: 'operations'; event: { type: string } } =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'operations' &&
          'event' in message &&
          typeof message.event === 'object' &&
          message.event !== null &&
          'type' in message.event &&
          typeof message.event.type === 'string',
      );
      return candidate?.event.type === 'op-started' ? candidate : undefined;
    });
    expect(streamed.event.type).toBe('op-started');
    await waitFor(async () =>
      fullMessages.some(
        (message): message is { type: 'operations' } =>
          typeof message === 'object' && message !== null && 'type' in message && message.type === 'operations',
      ) || undefined,
    );
    fullWs.close();
    readWs.close();
  });
});
