import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { trackerDismissals } from '../src/db/schema.js';
import { startServer, waitFor, type TestServer } from './helpers.js';

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
    expect((await server.app.ctx.tasks.get(created.body.id)).state).toBe('running');
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
    await server.app.ctx.tasks.setState(created.body.id, 'running');

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
        drive: 'afk',
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
 * Run is cut from and lands back onto. Plain and per-Task, unlike the four
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

  it('reattempt copies the original\'s baseBranch onto the new task', async () => {
    const created = await server.api('POST', '/api/tasks', {
      prompt: 'will fail then be re-attempted',
      baseBranch: 'integration/x',
    });
    await server.api('POST', `/api/tasks/${created.body.id}/cancel`);
    // cancel is terminal (reattempt requires a finished task), matching the
    // convention used elsewhere in this file for driving a task to terminal
    // without running a real agent.
    const cancelled = await server.api('GET', `/api/tasks/${created.body.id}`);
    expect(cancelled.body.state).toBe('cancelled');

    const reattempted = await server.api('POST', `/api/tasks/${created.body.id}/reattempt`, { feedback: 'try again' });
    expect(reattempted.status).toBe(201);
    expect(reattempted.body.baseBranch).toBe('integration/x');
    expect(reattempted.body.reattemptOf).toBe(created.body.id);
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
    expect(body.model).toBe('claude-sonnet-5'); // resolved global default
    expect(body.overrides.model).toBeNull(); // ...but not pinned
  });

  it("follows the Workspace default model for tasks that haven't pinned one, leaving pinned tasks alone", async () => {
    const inheriting = (await server.api('POST', '/api/tasks', { prompt: 'follow the workspace' })).body;
    const pinned = (await server.api('POST', '/api/tasks', { prompt: 'stay put', model: 'pinned-model' })).body;
    expect(inheriting.overrides.model).toBeNull();
    expect(pinned.overrides.model).toBe('pinned-model');

    const patched = await server.api('PATCH', `/api/workspaces/${await workspaceId()}`, { model: 'ws-default-model' });
    expect(patched.status).toBe(200);

    const after = (await server.api('GET', `/api/tasks/${inheriting.id}`)).body;
    expect(after.model).toBe('ws-default-model'); // the inheriting task moved
    expect(after.overrides.model).toBeNull(); // still inheriting, not silently pinned

    const stillPinned = (await server.api('GET', `/api/tasks/${pinned.id}`)).body;
    expect(stillPinned.model).toBe('pinned-model'); // the pinned task did not
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
    expect(pinned.body.state).toBe('ready'); // blockers are derived, just re-pointed
    expect(pinned.body.openBlockerCount).toBe(1);
    expect(pinned.body.model).toBe('chosen-model');
    expect(pinned.body.overrides.model).toBe('chosen-model');

    const cleared = await server.api('PATCH', `/api/tasks/${blocked.body.id}`, { model: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.overrides.model).toBeNull(); // back to inherit
    // Inherit resolves to the Workspace default set by the test above — proof
    // the cleared field tracks the Workspace, not a frozen global default.
    expect(cleared.body.model).toBe('ws-default-model');
  });
});

/**
 * `skipReason` (issue #171): the transient House-Rule reason (ADR-0022,
 * issue #120) a ready Task's own API shape carries when the Auto-Runner's
 * last pick pass skipped it for a held Work Context — surfaced directly on
 * `taskToApi` (`AutoRunner.skipReasonFor`) rather than only through the
 * separate lease-diagnostics surface (issue #125).
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
    await server.app.ctx.tasks.setState(occupant.body.id, 'running');

    const blocked = await server.api('POST', '/api/tasks', {
      prompt: 'blocked, same context',
      workingDir: occupant.body.workingDir,
    });

    // Enabling Auto-Runner pokes it; the fill pass skips `blocked` (context
    // occupied, per the House Rule — #120), the same mechanics lease-routes.test.ts
    // exercises for the diagnostics surface.
    await server.api('PATCH', '/api/config', { autoRunner: { enabled: true, maxConcurrentRuns: 1 } });
    await waitFor(async () => server.app.ctx.autoRunner.skipReasonFor(blocked.body.id) ?? undefined);

    const res = await server.api('GET', `/api/tasks/${blocked.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.skipReason).toBe(`Work Context held by task ${occupant.body.id} (running)`);
  });
});
