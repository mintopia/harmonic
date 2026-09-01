import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

async function connectWs(server: TestServer): Promise<{ messages: any[]; close: () => void }> {
  const ws = new WebSocket(`${server.baseUrl.replace('http', 'ws')}/api/ws?token=${server.sessionToken}`);
  const messages: any[] = [];
  ws.addEventListener('message', (ev) => messages.push(JSON.parse(String(ev.data))));
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  return { messages, close: () => ws.close() };
}

async function events(server: TestServer, id: number): Promise<any[]> {
  return (await server.api('GET', `/api/conversations/${id}/events`)).body.events;
}

async function askPermission(server: TestServer, ws: { messages: any[] }) {
  const { body: convo } = await server.api('POST', '/api/conversations', {});
  await server.api('POST', `/api/conversations/${convo.id}/turns`, {
    text: JSON.stringify({ requestPermission: { title: 'Write file' }, updates: [] }),
  });
  const pending = await waitFor(async () =>
    ws.messages.find((m) => m.type === 'permission_request' && m.conversationId === convo.id),
  );
  return { convo, reqId: pending.reqId as string, request: pending.request };
}

describe('interactive conversation permissions (issue 11)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  it('holds the request open, broadcasts it, and the Turn waits until answered', async () => {
    const ws = await connectWs(server);
    const { convo, reqId, request } = await askPermission(server, ws);

    expect(request.options.map((o: any) => o.kind)).toContain('allow_once');
    expect((await events(server, convo.id)).some((e) => e.type === 'permission_request')).toBe(false);

    const allowOnce = request.options.find((o: any) => o.kind === 'allow_once');
    const res = await server.api('POST', `/api/conversations/${convo.id}/permissions/${reqId}`, {
      optionId: allowOnce.optionId,
    });
    expect(res.status).toBe(200);

    const resolved = await waitFor(async () =>
      (await events(server, convo.id)).find((e) => e.type === 'permission_request'),
    );
    expect(resolved.payload.outcome).toEqual({ outcome: 'selected', optionId: allowOnce.optionId });
    expect(resolved.payload.reqId).toBe(reqId);
    await waitFor(async () =>
      (await events(server, convo.id)).some(
        (e) => e.type === 'session_update' && String(e.payload?.content?.text ?? '').startsWith('permission:'),
      ),
    );
    ws.close();
  });

  it('forwards the native allow_always option for "Allow for this conversation"', async () => {
    const ws = await connectWs(server);
    const { convo, reqId, request } = await askPermission(server, ws);
    const allowAlways = request.options.find((o: any) => o.kind === 'allow_always');
    await server.api('POST', `/api/conversations/${convo.id}/permissions/${reqId}`, { optionId: allowAlways.optionId });
    const resolved = await waitFor(async () =>
      (await events(server, convo.id)).find((e) => e.type === 'permission_request'),
    );
    expect(resolved.payload.outcome.optionId).toBe(allowAlways.optionId);
    ws.close();
  });

  it('honours a reject option', async () => {
    const ws = await connectWs(server);
    const { convo, reqId, request } = await askPermission(server, ws);
    const reject = request.options.find((o: any) => o.kind.startsWith('reject'));
    await server.api('POST', `/api/conversations/${convo.id}/permissions/${reqId}`, { optionId: reject.optionId });
    const resolved = await waitFor(async () =>
      (await events(server, convo.id)).find((e) => e.type === 'permission_request'),
    );
    expect(resolved.payload.outcome.optionId).toBe(reject.optionId);
    ws.close();
  });

  it('rejects answering an unknown or already-resolved request', async () => {
    const ws = await connectWs(server);
    const { convo, reqId, request } = await askPermission(server, ws);
    const optionId = request.options[0].optionId;
    await server.api('POST', `/api/conversations/${convo.id}/permissions/${reqId}`, { optionId });
    const again = await server.api('POST', `/api/conversations/${convo.id}/permissions/${reqId}`, { optionId });
    expect(again.status).toBe(404);
    const bogus = await server.api('POST', `/api/conversations/${convo.id}/permissions/perm-999999`, { optionId });
    expect(bogus.status).toBe(404);
    ws.close();
  });

  it('cleans up a pending request when the Conversation ends, never leaking it', async () => {
    const ws = await connectWs(server);
    const { convo, reqId } = await askPermission(server, ws);

    await server.api('POST', `/api/conversations/${convo.id}/end`);

    const cancelled = await waitFor(async () =>
      (await events(server, convo.id)).find((e) => e.type === 'permission_request' && e.payload.reqId === reqId),
    );
    expect(cancelled.payload.outcome).toEqual({ outcome: 'cancelled' });
    expect((await server.api('GET', `/api/conversations/${convo.id}`)).body.state).toBe('ended');
    const answer = await server.api('POST', `/api/conversations/${convo.id}/permissions/${reqId}`, { optionId: 'x' });
    expect(answer.status).toBe(404);
    ws.close();
  });
});
