import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mirroredAgentEligible } from '../src/domain/agent-workable.js';
import type { MirrorInput } from '../src/domain/tasks.js';
import type { TrackerFacts } from '../src/db/schema.js';
import { isEpicTypeContainer, resolveTrackerAdapter, trackerRef } from '../src/tracker/adapter.js';
import { fakeForgejo, issue } from './helpers/fake-forgejo.js';
import { seedWorkspace, startServer, type TestServer } from './helpers.js';

const dirs: string[] = [];
let server: TestServer | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  await server?.close();
  server = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const mirrored = (ref: number, labels: string[]): MirrorInput => {
  const facts: TrackerFacts = {
    state: 'open',
    parent: null,
    blockedBy: [],
    labels,
    title: `ticket ${ref}`,
    body: '',
    url: `https://example.test/${ref}`,
    createdAt: '2026-08-01T00:00:00Z',
  };
  return { trackerRef: trackerRef(ref), prompt: `ticket ${ref}`, workflow: 'implement', wayfinderType: null, mapRef: null, closed: false, facts };
};

describe('mirroredAgentEligible with Triage Labels', () => {
  const custom = { readyForAgent: 'agent:go', readyForHuman: 'human:only' };

  it('defaults to the canonical labels', () => {
    expect(mirroredAgentEligible(['ready-for-agent'], null, false)).toBe(true);
    expect(mirroredAgentEligible(['agent:go'], null, false)).toBe(false);
  });

  it('honours the resolved readyForAgent and readyForHuman labels instead of the canonical ones', () => {
    expect(mirroredAgentEligible(['agent:go'], null, false, custom)).toBe(true);
    expect(mirroredAgentEligible(['ready-for-agent'], null, false, custom)).toBe(false);
    expect(mirroredAgentEligible(['agent:go', 'human:only'], null, false, custom)).toBe(false);
    expect(mirroredAgentEligible(['agent:go', 'ready-for-human'], null, false, custom)).toBe(true);
  });
});

describe('a Workspace Triage Labels override decides agent eligibility', () => {
  async function start(triageLabels: Record<string, string> | null, repoDoc?: string) {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-triage-'));
    dirs.push(dir);
    if (repoDoc) {
      mkdirSync(join(dir, 'docs/agents'), { recursive: true });
      writeFileSync(join(dir, 'docs/agents/triage-labels.md'), repoDoc);
    }
    server = await startServer();
    const id = await seedWorkspace(server.app.ctx.asyncDb);
    await server.app.ctx.workspaces.update(id, { workingDir: dir, triageLabels });
    return { tasks: server.app.ctx.tasks, id };
  }

  it('a ticket carrying the overridden label is agent-workable and one carrying the canonical label is not', async () => {
    const { tasks, id } = await start({ readyForAgent: 'agent:go' });
    const overridden = await tasks.upsertMirrored(mirrored(1, ['agent:go']), id);
    const canonical = await tasks.upsertMirrored(mirrored(2, ['ready-for-agent']), id);

    expect(await tasks.withDeps(overridden)).toMatchObject({ agentWorkable: true, humanOnly: false });
    expect(await tasks.withDeps(canonical)).toMatchObject({ agentWorkable: false, humanOnly: true });
    expect((await tasks.orderedEligibleWork(id)).map((t) => t.id)).toEqual([overridden.id]);
  });

  it('the repo role table applies when the Workspace sets nothing, and the Workspace setting wins over it', async () => {
    const doc = '| Label in mattpocock/skills | Label in our tracker |\n| --- | --- |\n| `ready-for-agent` | `agent:repo` |\n';
    const fromRepo = await start(null, doc);
    const viaRepo = await fromRepo.tasks.upsertMirrored(mirrored(1, ['agent:repo']), fromRepo.id);
    expect((await fromRepo.tasks.withDeps(viaRepo)).agentWorkable).toBe(true);
    await server?.close();

    const overridden = await start({ readyForAgent: 'agent:ws' }, doc);
    const viaDoc = await overridden.tasks.upsertMirrored(mirrored(1, ['agent:repo']), overridden.id);
    expect((await overridden.tasks.withDeps(viaDoc)).agentWorkable).toBe(false);
  });
});

describe('the epic and wayfinderMap Triage Labels', () => {
  const scan = async (triageLabels: { epic?: string; wayfinderMap?: string }) => {
    const fake = fakeForgejo({ issues: [issue(1, 'Container', { labels: ['initiative'] }), issue(2, 'Map', { labels: ['map:x'] }), issue(3, 'Plain')] });
    vi.stubGlobal('fetch', fake.http);
    const adapter = await resolveTrackerAdapter('/nonexistent', undefined, {
      configured: { kind: 'forgejo', settings: { baseUrl: 'https://forge.test', repo: 'owner/name' } },
      secrets: { FORGEJO_TOKEN: 'good' },
      triageLabels,
    });
    return new Map((await adapter.scan()).map((t) => [t.ref, t]));
  };

  it('an overridden epic label marks a ticket as an Epic container', async () => {
    const tickets = await scan({ epic: 'initiative' });
    expect(isEpicTypeContainer(tickets.get(trackerRef(1))!)).toBe(true);
    expect(isEpicTypeContainer(tickets.get(trackerRef(3))!)).toBe(false);
  });

  it('an overridden wayfinderMap label marks a ticket as a Map', async () => {
    const tickets = await scan({ wayfinderMap: 'map:x' });
    expect(tickets.get(trackerRef(2))!.isMap).toBe(true);
    expect(tickets.get(trackerRef(1))!.isMap).toBe(false);
  });

  it('without an override the canonical labels apply and a custom one means nothing', async () => {
    const tickets = await scan({});
    expect(isEpicTypeContainer(tickets.get(trackerRef(1))!)).toBe(false);
    expect(tickets.get(trackerRef(2))!.isMap).toBe(false);
  });
});
