import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
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

/** Ask one permission (given kind) in a conversation and wait for the held request to broadcast. */
async function ask(server: TestServer, ws: { messages: any[] }, convoId: number, kind = 'edit') {
  await server.api('POST', `/api/conversations/${convoId}/turns`, {
    text: JSON.stringify({ requestPermission: { title: `${kind} thing`, kind }, updates: [] }),
  });
  return waitFor(async () => ws.messages.find((m) => m.type === 'permission_request' && m.conversationId === convoId));
}

describe('persistent permission rules (issue 13)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  it('"Always allow in {dir}" writes a rule that auto-approves matching requests across Conversations', async () => {
    const ws = await connectWs(server);

    // Conversation A: prompt, then answer with remember → persists a rule.
    const { body: a } = await server.api('POST', '/api/conversations', {});
    const pending = await ask(server, ws, a.id, 'edit');
    const allowOnce = pending.request.options.find((o: any) => o.kind === 'allow_once');
    await server.api('POST', `/api/conversations/${a.id}/permissions/${pending.reqId}`, {
      optionId: allowOnce.optionId,
      remember: true,
    });

    // A rule now exists, keyed on kind + the conversation's working dir.
    const rules = await waitFor(async () => {
      const { body } = await server.api('GET', '/api/permission-rules');
      return body.rules.length > 0 ? body.rules : undefined;
    });
    expect(rules[0]).toMatchObject({ kind: 'edit', workingDir: a.workingDir });

    // A NEW Conversation in the same working dir: the same-kind request is
    // auto-approved — no prompt broadcast — and recorded flagged as rule-driven.
    const { body: b } = await server.api('POST', '/api/conversations', {});
    const before = ws.messages.filter((m) => m.type === 'permission_request').length;
    await server.api('POST', `/api/conversations/${b.id}/turns`, {
      text: JSON.stringify({ requestPermission: { title: 'edit thing', kind: 'edit' }, updates: [] }),
    });
    const resolved = await waitFor(async () =>
      (await events(server, b.id)).find((e) => e.type === 'permission_request'),
    );
    expect(resolved.payload.rule).toEqual({ kind: 'edit', workingDir: b.workingDir });
    expect(resolved.payload.outcome.outcome).toBe('selected');
    expect(ws.messages.filter((m) => m.type === 'permission_request' && m.conversationId === b.id)).toHaveLength(0);
    expect(ws.messages.filter((m) => m.type === 'permission_request').length).toBe(before);

    ws.close();
  });

  it('a non-matching request (different kind or dir) still prompts', async () => {
    const ws = await connectWs(server);
    // A rule for (edit, cwd) exists from the previous test. A different kind
    // in the same dir prompts.
    const { body: a } = await server.api('POST', '/api/conversations', {});
    const promptDifferentKind = await ask(server, ws, a.id, 'execute');
    expect(promptDifferentKind.request.toolCall.kind).toBe('execute');

    // Same kind (edit) but a different working directory does not match.
    const { body: b } = await server.api('POST', '/api/conversations', { workingDir: tmpdir() });
    const promptDifferentDir = await ask(server, ws, b.id, 'edit');
    expect(promptDifferentDir.conversationId).toBe(b.id);

    ws.close();
  });

  it('lists rules and, once revoked, matching requests prompt again', async () => {
    const ws = await connectWs(server);
    const { body } = await server.api('GET', '/api/permission-rules');
    const rule = body.rules.find((r: any) => r.kind === 'edit');
    expect(rule).toBeTruthy();

    const del = await server.api('DELETE', `/api/permission-rules/${rule.id}`);
    expect(del.status).toBe(200);
    expect((await server.api('GET', '/api/permission-rules')).body.rules.some((r: any) => r.id === rule.id)).toBe(false);

    // Now an edit request in that dir prompts again instead of auto-approving.
    const { body: c } = await server.api('POST', '/api/conversations', {});
    const prompt = await ask(server, ws, c.id, 'edit');
    expect(prompt.request.toolCall.kind).toBe('edit');

    // Revoking an unknown rule is a 404.
    const missing = await server.api('DELETE', '/api/permission-rules/999999');
    expect(missing.status).toBe(404);

    ws.close();
  });
});
