import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

interface Captured {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Local HTTP listener capturing webhook deliveries. */
function listen(): Promise<{ url: string; requests: Captured[]; close: () => void }> {
  const requests: Captured[] = [];
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requests.push({ path: req.url ?? '/', headers: req.headers, body });
        res.writeHead(200).end('ok');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => server.close() });
    });
  });
}

/** Dev SMTP sink capturing raw messages. */
function smtpSink(): Promise<{ port: number; mails: { from: string; to: string[]; data: string }[]; close: () => void }> {
  const mails: { from: string; to: string[]; data: string }[] = [];
  return new Promise((resolve) => {
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData(stream, session, callback) {
        let data = '';
        stream.on('data', (chunk) => (data += chunk));
        stream.on('end', () => {
          mails.push({
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
            to: session.envelope.rcptTo.map((r) => r.address),
            data,
          });
          callback();
        });
      },
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.server.address() as AddressInfo;
      resolve({ port, mails, close: () => server.close() });
    });
  });
}

describe('notification channels', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  const runToState = async (prompt: string, target: string): Promise<number> => {
    const created = await server.api('POST', '/api/tasks', { prompt });
    await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === target);
    return created.body.id;
  };

  it('creates channels with default subscriptions (awaiting-review + failed), edits and deletes them', async () => {
    const created = await server.api('POST', '/api/channels', {
      name: 'hooks',
      type: 'webhook',
      config: { url: 'http://127.0.0.1:1/unused' },
    });
    expect(created.status).toBe(201);
    expect(created.body.events).toEqual(['task.awaiting-review', 'task.failed']);

    const patched = await server.api('PATCH', `/api/channels/${created.body.id}`, {
      events: ['task.created', 'queue.idle'],
    });
    expect(patched.body.events).toEqual(['task.created', 'queue.idle']);

    expect((await server.api('DELETE', `/api/channels/${created.body.id}`)).status).toBe(200);
    const list = await server.api('GET', '/api/channels');
    expect(list.body.channels.find((c: any) => c.id === created.body.id)).toBeUndefined();

    // Junk is rejected.
    expect(
      (await server.api('POST', '/api/channels', { name: 'x', type: 'carrier-pigeon', config: {} })).status,
    ).toBe(400);
  });

  it('404s adding or listing per-task channel overrides for a task that does not exist', async () => {
    const channel = await server.api('POST', '/api/channels', {
      name: 'guard',
      type: 'webhook',
      config: { url: 'http://127.0.0.1:1/unused' },
    });
    // The existence guard is `await ctx.tasks.get(id)` (async since ADR-0029);
    // an un-awaited guard would silently pass and 200 on a missing task.
    expect(
      (await server.api('POST', '/api/tasks/999999/channels', { channelId: channel.body.id })).status,
    ).toBe(404);
    expect((await server.api('GET', '/api/tasks/999999/channels')).status).toBe(404);
  });

  it('delivers subscribed events to a generic webhook with a verifiable HMAC signature, and stays silent otherwise', async () => {
    const sink = await listen();
    const channel = await server.api('POST', '/api/channels', {
      name: 'sig',
      type: 'webhook',
      config: { url: `${sink.url}/hook`, secret: 'shh' },
      // default events: awaiting-review + failed
    });

    const taskId = await runToState('notify me', 'awaiting-review');

    await waitFor(async () => sink.requests.length > 0);
    const delivery = sink.requests[0]!;
    const payload = JSON.parse(delivery.body);
    expect(payload.event).toBe('task.awaiting-review');
    expect(payload.task.id).toBe(taskId);
    expect(typeof payload.timestamp).toBe('number');

    const expected = 'sha256=' + createHmac('sha256', 'shh').update(delivery.body).digest('hex');
    expect(delivery.headers['x-harmonic-signature']).toBe(expected);
    expect(delivery.headers['x-harmonic-event']).toBe('task.awaiting-review');

    // task.created is not subscribed: creating another task sends nothing new
    // for it (the accept below proves deliveries still flow afterwards).
    await server.api('POST', '/api/tasks', { prompt: 'silent', state: 'draft' });
    await server.api('POST', `/api/tasks/${taskId}/accept`);
    await new Promise((r) => setTimeout(r, 100));
    const events = sink.requests.map((r) => JSON.parse(r.body).event);
    expect(events).not.toContain('task.created');
    expect(events).not.toContain('task.completed');

    await server.api('DELETE', `/api/channels/${channel.body.id}`);
    sink.close();
  });

  it('formats discord and slack payloads for their webhooks', async () => {
    const sink = await listen();
    const discord = await server.api('POST', '/api/channels', {
      name: 'd',
      type: 'discord',
      config: { url: `${sink.url}/discord` },
    });
    const slack = await server.api('POST', '/api/channels', {
      name: 's',
      type: 'slack',
      config: { url: `${sink.url}/slack` },
    });

    await runToState('chat ping', 'awaiting-review');
    await waitFor(async () => sink.requests.length >= 2);

    const byPath = Object.fromEntries(sink.requests.map((r) => [r.path, JSON.parse(r.body)]));
    expect(typeof byPath['/discord'].content).toBe('string');
    expect(byPath['/discord'].content).toContain('awaiting review');
    expect(typeof byPath['/slack'].text).toBe('string');
    expect(byPath['/slack'].text).toContain('awaiting review');

    await server.api('DELETE', `/api/channels/${discord.body.id}`);
    await server.api('DELETE', `/api/channels/${slack.body.id}`);
    sink.close();
  });

  it('routes a specific task to a specific channel via per-task override', async () => {
    const sink = await listen();
    // Subscribed to nothing: only override traffic should arrive.
    const channel = await server.api('POST', '/api/channels', {
      name: 'override-only',
      type: 'webhook',
      config: { url: `${sink.url}/override` },
      events: [],
    });

    // Distinct workingDirs: run both Tasks concurrently without one blocking
    // the other on the direct-mode Work Context lease (issue #119) — the
    // default (shared) workingDir would serialize them here.
    const task = await server.api('POST', '/api/tasks', {
      prompt: 'special',
      workingDir: mkdtempSync(join(tmpdir(), 'harmonic-notify-')),
    });
    await server.api('POST', `/api/tasks/${task.body.id}/channels`, { channelId: channel.body.id });
    const other = await server.api('POST', '/api/tasks', {
      prompt: 'ordinary',
      workingDir: mkdtempSync(join(tmpdir(), 'harmonic-notify-')),
    });

    await server.api('POST', `/api/tasks/${task.body.id}/run`);
    await server.api('POST', `/api/tasks/${other.body.id}/run`);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${task.body.id}`)).body.state === 'awaiting-review');
    await waitFor(async () => (await server.api('GET', `/api/tasks/${other.body.id}`)).body.state === 'awaiting-review');
    await waitFor(async () => sink.requests.length > 0);
    await new Promise((r) => setTimeout(r, 100));

    const taskIds = sink.requests.map((r) => JSON.parse(r.body).task.id);
    expect(taskIds).toContain(task.body.id);
    expect(taskIds).not.toContain(other.body.id);

    await server.api('DELETE', `/api/channels/${channel.body.id}`);
    sink.close();
  });

  it('sends email through configured SMTP', async () => {
    const sink = await smtpSink();
    const channel = await server.api('POST', '/api/channels', {
      name: 'mail',
      type: 'email',
      config: {
        smtp: { host: '127.0.0.1', port: sink.port, secure: false },
        from: 'harmonic@example.com',
        to: 'operator@example.com',
      },
      events: ['task.failed'],
    });

    const taskId = await runToState(JSON.stringify({ exit: 'crash-before-response' }), 'failed');

    await waitFor(async () => sink.mails.length > 0, { timeoutMs: 15_000 });
    const mail = sink.mails[0]!;
    expect(mail.from).toBe('harmonic@example.com');
    expect(mail.to).toEqual(['operator@example.com']);
    // The body carries the documented JSON payload.
    expect(mail.data).toContain('"event": "task.failed"');
    expect(mail.data).toContain(`"id": ${taskId}`);

    await server.api('DELETE', `/api/channels/${channel.body.id}`);
    sink.close();
  });

  it('announces queue.idle when the last run drains', async () => {
    const sink = await listen();
    const channel = await server.api('POST', '/api/channels', {
      name: 'idle-watch',
      type: 'webhook',
      config: { url: `${sink.url}/idle` },
      events: ['queue.idle'],
    });

    await runToState('drain me', 'awaiting-review');
    await waitFor(async () => sink.requests.some((r) => JSON.parse(r.body).event === 'queue.idle'));

    await server.api('DELETE', `/api/channels/${channel.body.id}`);
    sink.close();
  });
});
