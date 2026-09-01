import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { trackerDismissals } from '../src/db/schema.js';
import { startServer, waitFor, type TestServer } from './helpers.js';
import { summarize } from '../src/server/dto.js';
import { toMirrorInput } from '../src/tracker/mirror.js';
import type { Ticket } from '../src/tracker/adapter.js';

describe('task authoring', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('creates a ready task from a prompt alone, filling every setting from config defaults', async () => {
    const { status, body } = await server.api('POST', '/api/tasks', {
      prompt: 'Write a haiku about worktrees',
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({
      prompt: 'Write a haiku about worktrees',
      state: 'ready',
      harness: 'claude',
      model: 'claude-sonnet-5',
      isolationMode: 'direct',
      priority: 'normal',
      skipReason: null,
    });
    expect(typeof body.id).toBe('number');
    expect(typeof body.workingDir).toBe('string');
    expect(body.workingDir.length).toBeGreaterThan(0);

    const list = await server.api('GET', '/api/tasks');
    expect(list.status).toBe(200);
    expect(list.body.tasks.map((t: any) => t.id)).toContain(body.id);
  });

  it('claims a ready task exactly once when schedulers race (issue #236)', async () => {
    const created = await server.api('POST', '/api/tasks', { prompt: 'Claim me' });

    const claims = await Promise.all([
      server.app.ctx.tasks.claimReady(created.body.id),
      server.app.ctx.tasks.claimReady(created.body.id),
    ]);

    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    expect((await server.app.ctx.tasks.get(created.body.id)).state).toBe('working');
  });

  it('saves a draft, allows editing while draft, and promotes it to ready', async () => {
    const created = await server.api('POST', '/api/tasks', {
      prompt: 'Draft me',
      state: 'draft',
    });
    expect(created.status).toBe(201);
    expect(created.body.state).toBe('draft');

    const edited = await server.api('PATCH', `/api/tasks/${created.body.id}`, {
      prompt: 'Draft me, edited',
      priority: 'high',
    });
    expect(edited.status).toBe(200);
    expect(edited.body.prompt).toBe('Draft me, edited');
    expect(edited.body.priority).toBe('high');
    expect(edited.body.state).toBe('draft');

    const promoted = await server.api('POST', `/api/tasks/${created.body.id}/ready`);
    expect(promoted.status).toBe(200);
    expect(promoted.body.state).toBe('ready');

    // Still editable while ready.
    const editedAgain = await server.api('PATCH', `/api/tasks/${created.body.id}`, {
      model: 'my-custom-model-id',
    });
    expect(editedAgain.status).toBe(200);
    expect(editedAgain.body.model).toBe('my-custom-model-id');
  });

  it('accepts a free-text model ID as well as configured list entries', async () => {
    const freeText = await server.api('POST', '/api/tasks', {
      prompt: 'p',
      model: 'some-experimental-model',
    });
    expect(freeText.status).toBe(201);
    expect(freeText.body.model).toBe('some-experimental-model');
  });

  it('cancels a non-terminal task, and refuses to touch it afterwards', async () => {
    const created = await server.api('POST', '/api/tasks', { prompt: 'Cancel me' });
    const cancelled = await server.api('POST', `/api/tasks/${created.body.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.state).toBe('cancelled');

    // cancelled is terminal: no edit, no promote, no second cancel.
    expect((await server.api('PATCH', `/api/tasks/${created.body.id}`, { prompt: 'x' })).status).toBe(409);
    expect((await server.api('POST', `/api/tasks/${created.body.id}/ready`)).status).toBe(409);
    expect((await server.api('POST', `/api/tasks/${created.body.id}/cancel`)).status).toBe(409);
  });

  it('uncancels a cancelled task back to ready, and refuses a non-cancelled task', async () => {
    const created = await server.api('POST', '/api/tasks', { prompt: 'Uncancel me' });
    await server.api('POST', `/api/tasks/${created.body.id}/cancel`);

    const uncancelled = await server.api('POST', `/api/tasks/${created.body.id}/uncancel`);
    expect(uncancelled.status).toBe(200);
    expect(uncancelled.body.state).toBe('ready');

    // ready is not cancelled: uncancel refuses.
    expect((await server.api('POST', `/api/tasks/${created.body.id}/uncancel`)).status).toBe(409);
  });

  it('uncancels to ready while retaining derived blockers when a dependency is unmet', async () => {
    const dep = await server.api('POST', '/api/tasks', { prompt: 'Dependency' });
    const blocked = await server.api('POST', '/api/tasks', {
      prompt: 'Depends on an incomplete task',
      dependsOn: [dep.body.id],
    });
    expect(blocked.body.state).toBe('ready');
    expect(blocked.body.openBlockerCount).toBe(1);
    expect(blocked.body.agentWorkable).toBe(false);

    await server.api('POST', `/api/tasks/${blocked.body.id}/cancel`);
    const uncancelled = await server.api('POST', `/api/tasks/${blocked.body.id}/uncancel`);
    expect(uncancelled.status).toBe(200);
    expect(uncancelled.body.state).toBe('ready');
    expect(uncancelled.body.openBlockerCount).toBe(1);
    expect(uncancelled.body.agentWorkable).toBe(false);
  });

  it('deletes a ready task outright: 200 { id }, then a 404 on GET (issue #162)', async () => {
    const created = await server.api('POST', '/api/tasks', { prompt: 'Delete me' });

    const deleted = await server.api('DELETE', `/api/tasks/${created.body.id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ id: created.body.id });

    expect((await server.api('GET', `/api/tasks/${created.body.id}`)).status).toBe(404);
  });

  it('refuses to delete a running task with 409, leaving it intact (issue #162)', async () => {
    const created = await server.api('POST', '/api/tasks', { prompt: 'Busy' });
    await server.app.ctx.tasks.setState(created.body.id, 'working');

    const deleted = await server.api('DELETE', `/api/tasks/${created.body.id}`);
    expect(deleted.status).toBe(409);

    expect((await server.api('GET', `/api/tasks/${created.body.id}`)).status).toBe(200);
  });

  it('404s deleting a task that does not exist (issue #162)', async () => {
    expect((await server.api('DELETE', '/api/tasks/999999')).status).toBe(404);
  });

  it('deletes a mirrored task and tombstones its tracker ref so a re-poll cannot resurrect it (issue #162)', async () => {
    const seeded = await server.api('POST', '/api/tasks', { prompt: 'seed for workspaceId' });
    const seededTask = await server.app.ctx.tasks.get(seeded.body.id);
    const mirrored = await server.app.ctx.tasks.upsertMirrored(
      {
        trackerRef: 91234,
        prompt: 'mirrored issue',
        workflow: 'implement',
        wayfinderType: null,
        mapRef: null,
        closed: false,
      },
      seededTask.workspaceId ?? undefined,
    );

    const deleted = await server.api('DELETE', `/api/tasks/${mirrored.id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ id: mirrored.id });
    expect((await server.api('GET', `/api/tasks/${mirrored.id}`)).status).toBe(404);

    const tombstones = await server.app.ctx.asyncDb.read((d) =>
      d.select().from(trackerDismissals).where(eq(trackerDismissals.trackerRef, 91234)).all(),
    );
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]!.workspaceId).toBe(seededTask.workspaceId);
  });

  it('a no-op re-poll of an unchanged mirrored issue neither emits task_changed nor bumps updatedAt', async () => {
    const seeded = await server.api('POST', '/api/tasks', { prompt: 'seed ws for no-op mirror' });
    const ws = (await server.app.ctx.tasks.get(seeded.body.id)).workspaceId ?? undefined;
    const input = {
      trackerRef: 90777,
      prompt: 'stable mirrored issue',
      workflow: 'implement' as const,
      wayfinderType: null,
      mapRef: null,
      closed: false,
    };
    const first = await server.app.ctx.tasks.upsertMirrored(input, ws);
    const before = await server.app.ctx.tasks.get(first.id);

    const emitted: number[] = [];
    const off = server.app.ctx.bus.on('task_changed', (t) => emitted.push(t.id));

    // Same issue, same fields: a re-poll that mirrors nothing new must be a true
    // no-op — no write, no task_changed. A large mirrored backlog otherwise fires
    // one frame per issue every poll, a firehose that hammers the board and Stats.
    await server.app.ctx.tasks.upsertMirrored(input, ws);
    expect(emitted).not.toContain(first.id);
    expect((await server.app.ctx.tasks.get(first.id)).updatedAt).toBe(before.updatedAt);

    // A material change still writes, emits, and bumps updatedAt.
    await server.app.ctx.tasks.upsertMirrored({ ...input, prompt: 'reworded body' }, ws);
    expect(emitted).toContain(first.id);
    expect((await server.app.ctx.tasks.get(first.id)).updatedAt).toBeGreaterThan(before.updatedAt);

    off();
  });

  it('rejects invalid input: empty prompt, unknown harness, unknown task', async () => {
    expect((await server.api('POST', '/api/tasks', { prompt: '' })).status).toBe(400);
    expect((await server.api('POST', '/api/tasks', { prompt: 'p', harness: 'gemini' })).status).toBe(400);
    expect((await server.api('GET', '/api/tasks/999999')).status).toBe(404);
  });

  it('exposes config so the UI can offer defaults and per-harness model lists', async () => {
    const { status, body } = await server.api('GET', '/api/config');
    expect(status).toBe(200);
    expect(body.defaults.harness).toBe('claude');
    expect(body.harnesses.claude.models).toContain('claude-sonnet-5');
    expect(body.harnesses.claude.defaultModel).toBe('claude-sonnet-5');
  });
});

/**
 * Per-Task explicit base branch (issue #157, ADR-0024): the branch a worktree
 * Run is cut from and merges back onto. Plain and per-Task, unlike the four
 * inheritable defaults — it never resolves against a Workspace/global value.
 */
describe('task baseBranch (issue #157)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('create with baseBranch persists it onto the returned TaskRow', async () => {
    const { status, body } = await server.api('POST', '/api/tasks', {
      prompt: 'target an integration branch',
      baseBranch: 'integration/x',
    });
    expect(status).toBe(201);
    expect(body.baseBranch).toBe('integration/x');

    const fetched = await server.api('GET', `/api/tasks/${body.id}`);
    expect(fetched.body.baseBranch).toBe('integration/x');
  });

  it('create without baseBranch leaves it null — the working dir\'s current branch resolves at spawn', async () => {
    const { status, body } = await server.api('POST', '/api/tasks', {
      prompt: 'no explicit base',
    });
    expect(status).toBe(201);
    expect(body.baseBranch).toBeNull();
  });

  it('update with baseBranch: null clears a previously-set value', async () => {
    const created = await server.api('POST', '/api/tasks', {
      prompt: 'starts pinned',
      baseBranch: 'integration/x',
    });
    expect(created.body.baseBranch).toBe('integration/x');

    const cleared = await server.api('PATCH', `/api/tasks/${created.body.id}`, { baseBranch: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.baseBranch).toBeNull();
  });

  it('keeps baseBranch on the same ticket across attempts', async () => {
    const created = await server.api('POST', '/api/tasks', {
      prompt: 'will fail then retry in place',
      baseBranch: 'integration/x',
    });
    const ticket = await server.api('GET', `/api/tasks/${created.body.id}`);
    expect(ticket.status).toBe(200);
    expect(ticket.body.baseBranch).toBe('integration/x');
  });
});

/**
 * Per-Task default overrides that inherit at read time (ADR-0012): a Task that
 * never pinned a default follows its Workspace/global default as it changes,
 * and a blocked Task can be re-pointed while it waits.
 */
describe('task-default inheritance', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
  });

  const workspaceId = async () => (await server.api('GET', '/api/workspaces')).body.workspaces[0].id as number;

  it('serves the effective model but marks an unpinned default as inherited (overrides null)', async () => {
    const { body } = await server.api('POST', '/api/tasks', { prompt: 'inherit my model' });
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.overrides.model).toBeNull();
  });

  it("follows the Workspace default model for tasks that haven't pinned one, leaving pinned tasks alone", async () => {
    const inheriting = (await server.api('POST', '/api/tasks', { prompt: 'follow the workspace' })).body;
    const pinned = (await server.api('POST', '/api/tasks', { prompt: 'stay put', model: 'pinned-model' })).body;
    expect(inheriting.overrides.model).toBeNull();
    expect(pinned.overrides.model).toBe('pinned-model');

    const patched = await server.api('PATCH', `/api/workspaces/${await workspaceId()}`, { model: 'ws-default-model' });
    expect(patched.status).toBe(200);

    const after = (await server.api('GET', `/api/tasks/${inheriting.id}`)).body;
    expect(after.model).toBe('ws-default-model');
    expect(after.overrides.model).toBeNull();

    const stillPinned = (await server.api('GET', `/api/tasks/${pinned.id}`)).body;
    expect(stillPinned.model).toBe('pinned-model');
  });

  it('resolves the conflict-resolve bound through the same chain as isolationMode', async () => {
    // Bare task: resolves the global default (config.ts), unpinned.
    const inherited = (await server.api('POST', '/api/tasks', { prompt: 'inherit the conflict-resolve bound' })).body;
    expect(inherited.conflictResolveTurns).toBe(2);
    expect(inherited.overrides.conflictResolveTurns).toBeNull();

    // Per-task override pins the value and marks it in `overrides`.
    const pinned = (await server.api('POST', '/api/tasks', { prompt: 'pin K', conflictResolveTurns: 9 })).body;
    expect(pinned.conflictResolveTurns).toBe(9);
    expect(pinned.overrides.conflictResolveTurns).toBe(9);

    // Workspace override moves every unpinned task; the pinned one holds.
    const patched = await server.api('PATCH', `/api/workspaces/${await workspaceId()}`, { conflictResolveTurns: 4 });
    expect(patched.status).toBe(200);
    const afterWs = (await server.api('GET', `/api/tasks/${inherited.id}`)).body;
    expect(afterWs.conflictResolveTurns).toBe(4);
    expect(afterWs.overrides.conflictResolveTurns).toBeNull();

    // Clearing a pinned override falls back to inherit.
    const cleared = await server.api('PATCH', `/api/tasks/${pinned.id}`, { conflictResolveTurns: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.overrides.conflictResolveTurns).toBeNull();
    expect(cleared.body.conflictResolveTurns).toBe(4);
  });

  it('edits a task with open blockers to re-point its model, and clears it back to inherit', async () => {
    const dep = await server.api('POST', '/api/tasks', { prompt: 'Dependency', state: 'draft' });
    const blocked = await server.api('POST', '/api/tasks', {
      prompt: 'Blocked, needs a new model',
      dependsOn: [dep.body.id],
    });
    expect(blocked.body.state).toBe('ready');
    expect(blocked.body.openBlockerCount).toBe(1);

    const pinned = await server.api('PATCH', `/api/tasks/${blocked.body.id}`, { model: 'chosen-model' });
    expect(pinned.status).toBe(200);
    expect(pinned.body.state).toBe('ready');
    expect(pinned.body.openBlockerCount).toBe(1);
    expect(pinned.body.model).toBe('chosen-model');
    expect(pinned.body.overrides.model).toBe('chosen-model');

    const cleared = await server.api('PATCH', `/api/tasks/${blocked.body.id}`, { model: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.overrides.model).toBeNull();
    // Inherit resolves to the Workspace default set by the test above — proof
    // the cleared field tracks the Workspace, not a frozen global default.
    expect(cleared.body.model).toBe('ws-default-model');
  });
});

/**
 * `skipReason` (issue #171): the transient House-Rule reason (ADR-0001) a
 * ready Task's own API shape carries when the Auto-Runner's last pick pass
 * skipped it for an occupied Work Context — surfaced directly on `taskToApi`
 * (`AutoRunner.skipReasonFor`).
 */
describe('task skipReason (issue #171)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('reports the House-Rule skip reason on a ready Task blocked by an occupied direct-mode Work Context', async () => {
    const occupant = await server.api('POST', '/api/tasks', { prompt: 'occupant' });
    await server.app.ctx.tasks.setState(occupant.body.id, 'working');

    const blocked = await server.api('POST', '/api/tasks', {
      prompt: 'blocked, same context',
      workingDir: occupant.body.workingDir,
    });

    // Enabling Auto-Runner pokes it; the fill pass skips `blocked` (context
    // occupied, per the House Rule — the scheduler pick predicate, ADR-0001).
    await server.api('PATCH', '/api/config', { autoRunner: { enabled: true, maxConcurrentAttempts: 1 } });
    await waitFor(async () => server.app.ctx.autoRunner.skipReasonFor(blocked.body.id) ?? undefined);

    const res = await server.api('GET', `/api/tasks/${blocked.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.skipReason).toBe(`Work Context held by task ${occupant.body.id} (working)`);
  });
});

describe('task list parent filter — Epic children (ADR-0011, #411)', () => {
  let server: TestServer;

  const childOf = (number: number, parent: number, title: string): Ticket => ({
    number,
    title,
    state: 'open',
    body: '',
    createdAt: '2026-08-07T00:00:00Z',
    closedAt: null,
    labels: [],
    assignees: [],
    parent,
    blockedBy: [],
    blocking: [],
    comments: [],
    isMap: false,
    url: `https://github.com/mintopia/harmonic/issues/${number}`,
  });

  beforeAll(async () => {
    server = await startServer();
    const { tasks } = server.app.ctx;
    await tasks.upsertMirrored(toMirrorInput(childOf(501, 42, 'Epic 42 child A')));
    await tasks.upsertMirrored(toMirrorInput(childOf(502, 42, 'Epic 42 child B')));
    await tasks.upsertMirrored(toMirrorInput(childOf(601, 99, 'Epic 99 child')));
    await server.api('POST', '/api/tasks', { prompt: 'A native task with no parent' });
  });
  afterAll(async () => {
    await server.close();
  });

  it('returns only the tasks whose tracker parent is the given Epic ref', async () => {
    const res = await server.api('GET', '/api/tasks?parent=42');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.tasks.map((t: any) => t.trackerRef).sort()).toEqual([501, 502]);
  });

  it('paginates and totals over the filtered child set', async () => {
    const res = await server.api('GET', '/api/tasks?parent=42&limit=1');
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.total).toBe(2);
  });

  it('an Epic with no children returns an empty page', async () => {
    const res = await server.api('GET', '/api/tasks?parent=123456');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.tasks).toHaveLength(0);
  });

  it('rejects a non-positive parent ref', async () => {
    const res = await server.api('GET', '/api/tasks?parent=0');
    expect(res.status).toBe(400);
  });
});

describe('task list pagination, search, and summary (ADR-0045, #347)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
    await server.api('POST', '/api/tasks', { prompt: 'Add rate limiting to POST /api/tasks\n\nGuard the write path.' });
    await server.api('POST', '/api/tasks', { prompt: 'Rewrite the auth middleware' });
    await server.api('POST', '/api/tasks', { prompt: 'Document the RATE limiter config' });
  });
  afterAll(async () => {
    await server.close();
  });

  it('returns lean rows: every task with a total, a summary, and no full prompt (issue #350)', async () => {
    const res = await server.api('GET', '/api/tasks');
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(3);
    expect(res.body.total).toBe(3);
    const first = res.body.tasks.find((t: any) => t.summary === 'Add rate limiting to POST /api/tasks');
    // The full prompt is dropped from list rows (ADR-0045); summary is the first line.
    expect(first).toBeDefined();
    expect(first.prompt).toBeUndefined();
    expect(res.body.tasks.every((t: any) => t.prompt === undefined)).toBe(true);
  });

  it('paginates with limit/offset while total stays the full match count', async () => {
    const page1 = await server.api('GET', '/api/tasks?limit=2');
    expect(page1.body.tasks).toHaveLength(2);
    expect(page1.body.total).toBe(3);

    const page2 = await server.api('GET', '/api/tasks?limit=2&offset=2');
    expect(page2.body.tasks).toHaveLength(1);
    expect(page2.body.total).toBe(3);

    const ids = [...page1.body.tasks, ...page2.body.tasks].map((t: any) => t.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('searches server-side: case-insensitive substring over the prompt, with a filtered total', async () => {
    const res = await server.api('GET', '/api/tasks?q=rate');
    expect(res.status).toBe(200);
    // "rate limiting" and "RATE limiter" both match, case-insensitively; "auth" does not.
    expect(res.body.total).toBe(2);
    expect(res.body.tasks).toHaveLength(2);
    // Search is server-side over the full prompt; the lean rows carry only summary.
    expect(res.body.tasks.every((t: any) => t.summary.toLowerCase().includes('rate'))).toBe(true);
  });

  it('a blank q matches everything (the no-search state)', async () => {
    const res = await server.api('GET', '/api/tasks?q=%20');
    expect(res.body.total).toBe(3);
  });

  it('rejects a limit over the max', async () => {
    const res = await server.api('GET', '/api/tasks?limit=1000');
    expect(res.status).toBe(400);
  });

  it('the item GET carries the full prompt and the summary too', async () => {
    const { body } = await server.api('GET', '/api/tasks');
    const id = body.tasks[0].id;
    const res = await server.api('GET', `/api/tasks/${id}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.prompt).toBe('string');
    expect(res.body.summary).toBe(summarize(res.body.prompt));
  });
});
