import { describe, it, expect } from 'vitest';
import { forgejoKind } from '../src/tracker/forgejo.js';
import { trackerRef, type TicketRef } from '../src/tracker/adapter.js';
import { fakeForgejo, issue, type FakeForgejoOptions } from './helpers/fake-forgejo.js';

const build = (options: FakeForgejoOptions, settings: Record<string, unknown> = {}) => {
  const fake = fakeForgejo(options);
  const ctx = {
    settings: forgejoKind.settings.parse({ baseUrl: 'https://forge.test', repo: 'owner/name', ...settings }),
    secrets: { FORGEJO_TOKEN: 'good' },
    repoRoot: '/repo',
    http: fake.http,
  };
  return { fake, ctx, adapter: forgejoKind.create(ctx) };
};
const ref = (number: string | number): TicketRef => ({ ref: trackerRef(number), title: '', state: 'open' });

describe('Forgejo tracker', () => {
  it('sends the token and reads the account for verify', async () => {
    const { fake, ctx } = build({ issues: [] }, {});
    expect(await forgejoKind.verify!(ctx)).toEqual({ ok: true, login: 'harmonic-bot' });
    expect(fake.requests[0]).toMatchObject({ path: '/user', auth: 'token good' });
    expect(await forgejoKind.verify!({ ...ctx, secrets: { FORGEJO_TOKEN: 'bad' } })).toMatchObject({ ok: false });
    expect(await forgejoKind.verify!({ ...ctx, secrets: {} })).toEqual({ ok: false, reason: 'The "FORGEJO_TOKEN" Secret is not set' });
  });

  it('reads the token from the Secret named in settings', () => {
    const ctx = { settings: forgejoKind.settings.parse({ baseUrl: 'https://forge.test', repo: 'owner/name', tokenSecret: 'MY_TOKEN' }), repoRoot: '/repo', http: fakeForgejo({ issues: [] }).http };
    expect(() => forgejoKind.create({ ...ctx, secrets: { FORGEJO_TOKEN: 'good' } })).toThrow('"MY_TOKEN" Secret');
    expect(() => forgejoKind.create({ ...ctx, secrets: { MY_TOKEN: 'good' } })).not.toThrow();
  });

  it('merges native dependencies with the body convention and tolerates dependencies being off', async () => {
    const issues = [issue(1, 'A'), issue(2, 'B'), issue(3, 'C', { body: 'Blocked by #1' })];
    const native = await build({ issues, dependencies: { 3: [2] } }).adapter.scan();
    expect(native.find((t) => t.ref === '3')!.blockedBy.map((r) => r.ref)).toEqual(['2', '1']);
    expect(native.find((t) => t.ref === '2')!.blocking.map((r) => r.ref)).toEqual(['3']);
    const off = await build({ issues, dependenciesEnabled: false }).adapter.scan();
    expect(off.find((t) => t.ref === '3')!.blockedBy.map((r) => r.ref)).toEqual(['1']);
  });

  it('claim assigns the token account and release removes only it; comments come with readTicket', async () => {
    const { fake, adapter } = build({ issues: [issue(1, 'A', { assignees: ['someone'] })] });
    await adapter.claim(ref(1));
    expect(fake.issues[0]!.assignees).toEqual(['someone', 'harmonic-bot']);
    await adapter.release(ref(1));
    expect(fake.issues[0]!.assignees).toEqual(['someone']);
    await adapter.close!(ref(1), 'done');
    const ticket = await adapter.readTicket(ref(1));
    expect([ticket.state, ticket.comments.map((c) => c.body)]).toEqual(['closed', ['done']]);
  });

  it('label source: epic-labelled issues are epics and children name them in the body', async () => {
    const { adapter } = build({ issues: [issue(1, 'Epic', { labels: ['epic'] }), issue(2, 'Child', { body: 'Part of #1' })] });
    const tickets = await adapter.scan();
    expect(tickets.map((t) => [t.ref, t.labels, t.parent])).toEqual([['1', ['epic'], null], ['2', [], '1']]);
  });

  it('milestone source: open milestones are epics, their issues are children, close closes the milestone', async () => {
    const ref7 = 'milestone-7';
    const container = { id: 7, title: 'Release', state: 'open' as const, issues: [1] };
    const closedContainer = { id: 8, title: 'Old', state: 'closed' as const, issues: [2] };
    const { fake, adapter } = build(
      { issues: [issue(1, 'In', { milestone: 7 }), issue(2, 'Out')], milestones: [container, closedContainer] },
      { epicSource: 'milestone' },
    );
    const tickets = await adapter.scan();
    const epic = tickets.find((t) => t.ref === ref7)!;
    expect([epic.title, epic.labels, epic.state, epic.parent]).toEqual(['Release', ['epic'], 'open', null]);
    expect(tickets.map((t) => [t.ref, t.parent])).toEqual([['1', ref7], ['2', null], [ref7, null]]);
    expect(tickets.some((t) => t.ref === 'milestone-8')).toBe(false);

    await adapter.claim(ref(ref7));
    await adapter.close!(ref(ref7), 'done');
    expect(fake.milestones.find((c) => c.id === 7)!.state).toBe('closed');
    expect(fake.comments).toEqual([]);
    await adapter.reopen!(ref(ref7), '');
    expect(fake.milestones.find((c) => c.id === 7)!.state).toBe('open');
  });
});

describe('Forgejo lifecycle writes are idempotent', () => {
  it('close transitions once and comments after the state change; a retry does neither again', async () => {
    const { fake, adapter } = build({ issues: [issue(1, 'A')] });
    await adapter.close!(ref(1), 'shipped');
    await adapter.close!(ref(1), 'shipped');
    expect(fake.issues[0]!.state).toBe('closed');
    expect(fake.comments).toEqual([{ issue: 1, body: 'shipped' }]);
    const writes = fake.requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`);
    expect(writes).toEqual(['PATCH /repos/owner/name/issues/1', 'POST /repos/owner/name/issues/1/comments']);
  });

  it('a failed transition leaves no comment behind to duplicate on retry', async () => {
    const { fake, adapter } = build({ issues: [issue(1, 'A')] });
    const http = fake.http;
    fake.http = async (url, init) => (init?.method === 'PATCH' ? new Response('boom', { status: 400 }) : http(url, init));
    const failing = forgejoKind.create({ settings: forgejoKind.settings.parse({ baseUrl: 'https://forge.test', repo: 'owner/name' }), secrets: { FORGEJO_TOKEN: 'good' }, repoRoot: '/repo', http: fake.http });
    await expect(failing.close!(ref(1), 'shipped')).rejects.toThrow();
    expect(fake.comments).toEqual([]);
    await adapter.close!(ref(1), 'shipped');
    expect(fake.comments).toHaveLength(1);
  });

  it('reopen is a no-op on an open issue', async () => {
    const { fake, adapter } = build({ issues: [issue(1, 'A')] });
    await adapter.reopen!(ref(1), 'again');
    expect(fake.comments).toEqual([]);
  });
});

describe('Forgejo replies are validated at the boundary', () => {
  it('rejects an issue list that is not shaped like issues', async () => {
    const http = async () => new Response(JSON.stringify([{ number: 'one' }]));
    const adapter = forgejoKind.create({ settings: forgejoKind.settings.parse({ baseUrl: 'https://forge.test', repo: 'owner/name' }), secrets: { FORGEJO_TOKEN: 'good' }, repoRoot: '/repo', http });
    await expect(adapter.scan()).rejects.toMatchObject({ name: 'RestError', message: expect.stringContaining('unexpected shape') });
  });

  it('identify reports the token account', async () => {
    expect(await build({ issues: [] }).adapter.identify!()).toBe('harmonic-bot');
  });
});
