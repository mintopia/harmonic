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
const ref = (number: string | number): TicketRef => ({ number: trackerRef(number), title: '', state: 'open' });

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
    expect(native.find((t) => t.number === '3')!.blockedBy.map((r) => r.number)).toEqual(['2', '1']);
    expect(native.find((t) => t.number === '2')!.blocking.map((r) => r.number)).toEqual(['3']);
    const off = await build({ issues, dependenciesEnabled: false }).adapter.scan();
    expect(off.find((t) => t.number === '3')!.blockedBy.map((r) => r.number)).toEqual(['1']);
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
    expect(tickets.map((t) => [t.number, t.labels, t.parent])).toEqual([['1', ['epic'], null], ['2', [], '1']]);
  });

  it.each([
    ['milestone', 'milestones', 'milestone-7'],
    ['project', 'projects', 'project-7'],
  ] as const)('%s source: open containers are epics, their issues are children, close closes the container', async (epicSource, key, ref7) => {
    const container = { id: 7, title: 'Release', state: 'open' as const, issues: [1] };
    const closedContainer = { id: 8, title: 'Old', state: 'closed' as const, issues: [2] };
    const { fake, adapter } = build(
      { issues: [issue(1, 'In', { milestone: epicSource === 'milestone' ? 7 : null }), issue(2, 'Out')], [key]: [container, closedContainer] },
      { epicSource },
    );
    const tickets = await adapter.scan();
    const epic = tickets.find((t) => t.number === ref7)!;
    expect([epic.title, epic.labels, epic.state, epic.parent]).toEqual(['Release', ['epic'], 'open', null]);
    expect(tickets.map((t) => [t.number, t.parent])).toEqual([['1', ref7], ['2', null], [ref7, null]]);
    expect(tickets.some((t) => t.number === 'project-8' || t.number === 'milestone-8')).toBe(false);

    await adapter.claim(ref(ref7));
    await adapter.close!(ref(ref7), 'done');
    expect(fake[key].find((c) => c.id === 7)!.state).toBe('closed');
    expect(fake.comments).toEqual([]);
    await adapter.reopen!(ref(ref7), '');
    expect(fake[key].find((c) => c.id === 7)!.state).toBe('open');
  });
});
