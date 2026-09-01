import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

async function events(server: TestServer, id: number): Promise<any[]> {
  return (await server.api('GET', `/api/conversations/${id}/events`)).body.events;
}
const userTurns = (evs: any[]) => evs.filter((e) => e.type === 'user_turn');
const finishedEvents = (evs: any[]) => evs.filter((e) => e.type === 'lifecycle' && e.payload.event === 'finished');

const slowTurn = (n: number, delayMs: number, marker: string) =>
  JSON.stringify({
    updates: Array.from({ length: n }, () => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: marker } })),
    delayMs,
  });

describe('conversation steering — queue and interrupt (issue 14)', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  it('queues a message typed during a running Turn and sends it as the next Turn', async () => {
    const { body: convo } = await server.api('POST', '/api/conversations', {});
    const first = await server.api('POST', `/api/conversations/${convo.id}/turns`, { text: slowTurn(6, 40, 'a') });
    expect(first.body).toEqual({ ok: true, queued: false });

    const second = await server.api('POST', `/api/conversations/${convo.id}/turns`, { text: slowTurn(1, 5, 'b') });
    expect(second.body).toEqual({ ok: true, queued: true });

    await waitFor(async () => (finishedEvents(await events(server, convo.id)).length === 2 ? true : undefined));
    const evs = await events(server, convo.id);
    const turns = userTurns(evs);
    expect(turns).toHaveLength(2);
    const firstFinished = finishedEvents(evs)[0];
    expect(turns[1].seq).toBeGreaterThan(firstFinished.seq);
  });

  it('interrupts a running Turn and re-prompts with the steering message', async () => {
    const { body: convo } = await server.api('POST', '/api/conversations', {});
    await server.api('POST', `/api/conversations/${convo.id}/turns`, { text: slowTurn(20, 30, 'x') });
    const res = await server.api('POST', `/api/conversations/${convo.id}/interrupt`, {
      text: slowTurn(1, 5, 'steered'),
    });
    expect(res.status).toBe(200);

    const cancelled = await waitFor(async () =>
      (await events(server, convo.id)).find((e) => e.type === 'lifecycle' && e.payload.stopReason === 'cancelled'),
    );
    expect(cancelled.payload.event).toBe('finished');
    await waitFor(async () => (userTurns(await events(server, convo.id)).length === 2 ? true : undefined));
    const evs = await events(server, convo.id);
    expect(userTurns(evs)[1].payload.text).toContain('steered');
    expect(userTurns(evs)[1].seq).toBeGreaterThan(cancelled.seq);
  });

  it('interrupt with an empty composer just stops the Turn — no new Turn', async () => {
    const { body: convo } = await server.api('POST', '/api/conversations', {});
    await server.api('POST', `/api/conversations/${convo.id}/turns`, { text: slowTurn(20, 30, 'y') });
    const res = await server.api('POST', `/api/conversations/${convo.id}/interrupt`, {});
    expect(res.status).toBe(200);

    const cancelled = await waitFor(async () =>
      (await events(server, convo.id)).find((e) => e.type === 'lifecycle' && e.payload.stopReason === 'cancelled'),
    );
    expect(cancelled).toBeTruthy();
    expect(userTurns(await events(server, convo.id))).toHaveLength(1);
    expect(server.app.ctx.conversationDriver.isWarm(convo.id)).toBe(true);
  });
});
