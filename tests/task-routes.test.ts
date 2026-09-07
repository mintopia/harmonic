import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AppConfig, type DeepPartial } from '../src/config.js';
import { Git } from '../src/execution/git.js';
import { type Ticket } from '../src/tracker/adapter.js';
import { startServer, stubHarness, type TestServer, waitFor } from './helpers.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('task-steering', () => {
  const scenario = (s: object) => JSON.stringify(s);

  const slowFirstTurn = (n = 6, delayMs = 80) =>
    scenario({
      updates: Array.from({ length: n }, (_, i) => ({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `step ${i}` },
      })),
      delayMs,
      stopReason: 'end_turn',
    });

  describe('steering a running task', () => {
    let server: TestServer;

    beforeAll(async () => {
      server = await startServer(stubHarness());
    });
    afterAll(async () => {
      await server.close();
    });

    it('delivers a queued steer as a follow-up turn, then settles (harness without mid-turn steering)', async () => {
      const overrides = stubHarness() as DeepPartial<AppConfig> & { harnesses: { claude: Record<string, unknown> } };
      overrides.harnesses.claude.env = { STUB_NO_STEERING: '1' };
      const noSteerServer = await startServer(overrides);
      try {
        const created = await noSteerServer.api('POST', '/api/tasks', { prompt: slowFirstTurn() });
        expect(created.status).toBe(201);
        const taskId = created.body.id;
        const started = await noSteerServer.api('POST', `/api/tasks/${taskId}/run`);
        expect(started.status).toBe(201);
        const attemptId = started.body.id;

        const steered = await waitFor(async () => {
          const res = await noSteerServer.api('POST', `/api/tasks/${taskId}/steer`, { text: 'reread the tests first' });
          return res.status === 200 ? res : undefined;
        });
        expect(steered.body).toEqual({ ok: true });

        await waitFor(async () => {
          const { body } = await noSteerServer.api('GET', `/api/tasks/${taskId}`);
          return body.state === 'done' ? body : undefined;
        });

        const { body } = await noSteerServer.api('GET', `/api/attempts/${attemptId}/events`);
        const lifecycle = body.events.filter((e: any) => e.type === 'lifecycle');
        expect(lifecycle.find((e: any) => e.payload.event === 'steer_queued')?.payload.text).toBe('reread the tests first');
        expect(lifecycle.find((e: any) => e.payload.event === 'steer_delivered')?.payload.text).toBe('reread the tests first');
        expect(lifecycle.find((e: any) => e.payload.event === 'steer_injected')).toBeUndefined();

      } finally {
        await noSteerServer.close();
      }
    });

    it('injects a steer into the running turn when the harness supports it', async () => {
      const turnStartedFile = join(mkdtempSync(join(tmpdir(), 'harmonic-steer-')), 'turn-started');
      const created = await server.api('POST', '/api/tasks', {
        prompt: scenario({
          updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } }],
          writeFiles: { [turnStartedFile]: 'started\n' },
          waitForSteer: true,
          stopReason: 'end_turn',
        }),
      });
      expect(created.status).toBe(201);
      const taskId = created.body.id;
      const started = await server.api('POST', `/api/tasks/${taskId}/run`);
      expect(started.status).toBe(201);
      const attemptId = started.body.id;

      await waitFor(async () => existsSync(turnStartedFile));

      const steered = await waitFor(async () => {
        const res = await server.api('POST', `/api/tasks/${taskId}/steer`, { text: 'switch to the other approach' });
        return res.status === 200 ? res : undefined;
      });
      expect(steered.body).toEqual({ ok: true });

      await waitFor(async () => {
        const { body } = await server.api('GET', `/api/tasks/${taskId}`);
        return body.state === 'done' ? body : undefined;
      });

      const { body } = await server.api('GET', `/api/attempts/${attemptId}/events`);
      const lifecycle = body.events.filter((e: any) => e.type === 'lifecycle');
      expect(lifecycle.find((e: any) => e.payload.event === 'steer_injected')?.payload.text).toBe(
        'switch to the other approach',
      );
      expect(lifecycle.find((e: any) => e.payload.event === 'steer_delivered')).toBeUndefined();

    });

    it('409s a steer after the run has fully settled, never a 200 that vanishes', async () => {
      const created = await server.api('POST', '/api/tasks', { prompt: 'quick task' });
      const taskId = created.body.id;
      const started = await server.api('POST', `/api/tasks/${taskId}/run`);
      expect(started.status).toBe(201);

      await waitFor(async () => {
        const { body } = await server.api('GET', `/api/tasks/${taskId}`);
        return body.state === 'done' ? body : undefined;
      });

      const res = await server.api('POST', `/api/tasks/${taskId}/steer`, { text: 'too late' });
      expect(res.status).toBe(409);
    });

    it('409s when the task has no active run to steer', async () => {
      const draft = await server.api('POST', '/api/tasks', { prompt: 'not running' });
      const res = await server.api('POST', `/api/tasks/${draft.body.id}/steer`, { text: 'hello' });
      expect(res.status).toBe(409);
    });

    it('rejects an empty steer message', async () => {
      const draft = await server.api('POST', '/api/tasks', { prompt: 'x' });
      const res = await server.api('POST', `/api/tasks/${draft.body.id}/steer`, { text: '' });
      expect(res.status).toBe(400);
    });
  });

  describe('steering a settled task continues its session', () => {
    let server: TestServer;

    beforeAll(async () => {
      const scenarioPrompt = scenario({
        updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'thinking' } }],
        stopReason: 'end_turn',
      });
      const overrides = stubHarness() as DeepPartial<AppConfig>;
      overrides.harnesses!.claude!.cacheWarmSeconds = 1;
      overrides.maxAttempts = 1;
      overrides.drive = { prompt: scenarioPrompt };
      server = await startServer(overrides);
    });
    afterAll(async () => {
      await server.close();
    });

    it('continues a cold session in the same attempt seeded with the operator message', async () => {
      const seed = (await server.api('POST', '/api/tasks', { prompt: 'workspace seed' })).body;
      const workspaceId = (await server.app.ctx.tasks.get(seed.id)).workspaceId ?? undefined;
      const mirrored = await server.app.ctx.tasks.upsertMirrored(
        { trackerRef: 90210, prompt: 'ticket 90210\n\nbody', workflow: 'implement', wayfinderType: null, mapRef: null, closed: false },
        workspaceId,
      );
      await server.api('POST', `/api/tasks/${mirrored.id}/run`);
      await waitFor(async () => {
        const task = (await server.api('GET', `/api/tasks/${mirrored.id}`)).body;
        return task.state === 'escalated' ? task : undefined;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
      const runsBefore = await server.app.ctx.attempts.listForTask(mirrored.id);
      const attemptBefore = runsBefore.at(-1);

      const steered = await server.api('POST', `/api/tasks/${mirrored.id}/steer`, { text: 'actually, focus on the parser' });
      expect(steered.status).toBe(200);
      expect(steered.body).toEqual({ ok: true });

      const latest = await waitFor(async () => {
        const all = await server.app.ctx.attempts.listForTask(mirrored.id);
        const last = all.at(-1);
        return all.length === runsBefore.length && last?.prompt?.includes('actually, focus on the parser') ? last : undefined;
      });
      expect(latest.id).toBe(attemptBefore?.id);
      expect(latest.prompt).toContain('## Operator message');
      expect(latest.prompt).not.toContain('ticket 90210');
    });

    it('409s when the settled task has no warm session (e.g. a plain done native task)', async () => {
      const workingDir = mkdtempSync(join(tmpdir(), 'harmonic-steer-native-'));
      execFileSync('git', ['init', '-b', 'main', workingDir]);
      execFileSync('git', ['-C', workingDir, 'config', 'user.name', 'Test']);
      execFileSync('git', ['-C', workingDir, 'config', 'user.email', 'test@example.com']);
      execFileSync('git', ['-C', workingDir, 'commit', '--allow-empty', '-m', 'init']);

      const created = await server.api('POST', '/api/tasks', { prompt: 'quick native task', workingDir });
      const taskId = created.body.id;
      const started = await server.api('POST', `/api/tasks/${taskId}/run`);
      expect(started.status).toBe(201);
      await waitFor(async () => ((await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done' ? true : undefined));
      const res = await server.api('POST', `/api/tasks/${taskId}/steer`, { text: 'too late' });
      expect(res.status).toBe(409);
    });
  });
});

describe('task-list-epics', () => {
  describe('Tasks list epic rows from the derived model (issue #418)', () => {
    let server: TestServer;
    let workspaceId: number;

    const epicTicket = (over: Partial<Ticket>): Ticket => ({
      number: 101,
      title: 'Alpha epic',
      state: 'open',
      body: '',
      createdAt: '2020-01-01T00:00:00.000Z',
      closedAt: null,
      labels: ['epic'],
      assignees: [],
      parent: null,
      blockedBy: [],
      blocking: [],
      comments: [],
      isMap: false,
      url: 'https://tracker/101',
      ...over,
    });
    const alpha = epicTicket({});
    const beta = epicTicket({ number: 102, title: 'Beta epic', createdAt: '2999-01-01T00:00:00.000Z', url: 'https://tracker/102' });

    beforeEach(async () => {
      server = await startServer(stubHarness());
      const a = await server.api('POST', '/api/tasks', { prompt: 'task a', priority: 'low', state: 'draft' });
      workspaceId = a.body.workspaceId;
      await server.api('POST', '/api/tasks', { prompt: 'task b', priority: 'high', harness: 'codex' });
      await server.api('POST', '/api/tasks', { prompt: 'task c' });
      vi.spyOn(server.app.ctx.trackerManager, 'listEpicTickets').mockResolvedValue([alpha, beta]);
    });
    afterEach(async () => {
      await server.close();
    });

    const rows = (body: any) => body.tasks as any[];
    const summaries = (body: any) => rows(body).map((t) => t.summary);

    it('merges derived-epic rows into the list, counted in the total', async () => {
      const res = await server.api('GET', `/api/tasks?workspaceId=${workspaceId}&epics=true`);
      expect(res.status).toBe(200);
      expect(summaries(res.body).sort()).toEqual(['Alpha epic', 'Beta epic', 'task a', 'task b', 'task c']);
      expect(res.body.total).toBe(5);
      const epicRow = rows(res.body).find((t) => t.summary === 'Alpha epic');
      expect(epicRow).toMatchObject({ isEpic: true, trackerRef: 101, url: 'https://tracker/101' });
    });

    it('omits epic rows unless epics=true is requested', async () => {
      const res = await server.api('GET', `/api/tasks?workspaceId=${workspaceId}`);
      expect(summaries(res.body).sort()).toEqual(['task a', 'task b', 'task c']);
      expect(res.body.total).toBe(3);
      expect(rows(res.body).some((t) => t.isEpic)).toBe(false);
    });

    it('interleaves epic rows under the shared createdAt sort, both directions', async () => {
      const asc = await server.api('GET', `/api/tasks?workspaceId=${workspaceId}&epics=true&sortBy=createdAt&order=asc`);
      expect(summaries(asc.body)).toEqual(['Alpha epic', 'task a', 'task b', 'task c', 'Beta epic']);

      const desc = await server.api('GET', `/api/tasks?workspaceId=${workspaceId}&epics=true&sortBy=createdAt&order=desc`);
      expect(summaries(desc.body)).toEqual(['Beta epic', 'task c', 'task b', 'task a', 'Alpha epic']);
    });

    it('keeps pagination coherent — the total counts the merged set while a page slices it', async () => {
      const page = await server.api('GET', `/api/tasks?workspaceId=${workspaceId}&epics=true&sortBy=createdAt&order=asc&limit=1`);
      expect(summaries(page.body)).toEqual(['Alpha epic']);
      expect(page.body.total).toBe(5);
    });

    it('drops epic rows when a task-attribute filter is active (containers have no state/harness/priority)', async () => {
      const byState = await server.api('GET', `/api/tasks?workspaceId=${workspaceId}&epics=true&state=draft`);
      expect(summaries(byState.body)).toEqual(['task a']);

      const byPriority = await server.api('GET', `/api/tasks?workspaceId=${workspaceId}&epics=true&priority=high`);
      expect(summaries(byPriority.body)).toEqual(['task b']);
    });

    it('applies the title search to epic rows', async () => {
      const hit = await server.api('GET', `/api/tasks?workspaceId=${workspaceId}&epics=true&q=Alpha`);
      expect(summaries(hit.body)).toEqual(['Alpha epic']);

      const miss = await server.api('GET', `/api/tasks?workspaceId=${workspaceId}&epics=true&q=task%20b`);
      expect(summaries(miss.body)).toEqual(['task b']);
    });
  });
});

describe('task-list-branch', () => {
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-repo-'));
    execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(dir, 'README.md'), '# repo\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'init');
    return dir;
  }

  describe('task list payload: latest run branch', () => {
    let server: TestServer;

    beforeAll(async () => {
      server = await startServer(stubHarness());
    });
    afterAll(async () => {
      await server.close();
    });

    it('carries the latest run\'s branch once done, spawning no git process', async () => {
      const repo = makeRepo();
      const created = await server.api('POST', '/api/tasks', {
        prompt: JSON.stringify({ writeFiles: { 'feature.txt': 'made by agent\n' } }),
        workingDir: repo,
        isolationMode: 'worktree',
      });
      await server.api('POST', `/api/tasks/${created.body.id}/run`);
      await waitFor(
        async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'done',
      );

      const gitSpies = Object.keys(Git).map((method) => vi.spyOn(Git as any, method));
      const list = await server.api('GET', '/api/tasks');
      for (const spy of gitSpies) expect(spy).not.toHaveBeenCalled();
      gitSpies.forEach((s) => s.mockRestore());

      const task = list.body.tasks.find((t: any) => t.id === created.body.id);
      expect(task.branch).toBe(`harmonic/task-${created.body.id}`);
      expect(task.stat).toMatch(/^\d+\t\d+\tfeature\.txt/m);
      const runs = await server.api('GET', `/api/tasks/${created.body.id}/attempts`);
      const diff = await server.api('GET', `/api/attempts/${runs.body.attempts.at(-1).id}/diff`);
      expect(diff.body.stat).toBe(task.stat);
    });

    it('is null for a direct-mode task (no run yet)', async () => {
      const created = await server.api('POST', '/api/tasks', { prompt: 'noop' });
      const list = await server.api('GET', '/api/tasks');
      const task = list.body.tasks.find((t: any) => t.id === created.body.id);
      expect(task.branch).toBeNull();
      expect(task.stat).toBeNull();
    });
  });
});
