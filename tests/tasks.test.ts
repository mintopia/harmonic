import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type TestServer } from './helpers.js';

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
    });
    expect(typeof body.id).toBe('number');
    expect(typeof body.workingDir).toBe('string');
    expect(body.workingDir.length).toBeGreaterThan(0);

    const list = await server.api('GET', '/api/tasks');
    expect(list.status).toBe(200);
    expect(list.body.tasks.map((t: any) => t.id)).toContain(body.id);
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

  it('uncancels to blocked when the task has an unmet dependency', async () => {
    const dep = await server.api('POST', '/api/tasks', { prompt: 'Dependency' });
    const blocked = await server.api('POST', '/api/tasks', {
      prompt: 'Depends on an incomplete task',
      dependsOn: [dep.body.id],
    });
    expect(blocked.body.state).toBe('blocked');

    await server.api('POST', `/api/tasks/${blocked.body.id}/cancel`);
    const uncancelled = await server.api('POST', `/api/tasks/${blocked.body.id}/uncancel`);
    expect(uncancelled.status).toBe(200);
    expect(uncancelled.body.state).toBe('blocked');
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

  it('edits a blocked task to re-point its model, and clears it back to inherit', async () => {
    const dep = await server.api('POST', '/api/tasks', { prompt: 'Dependency', state: 'draft' });
    const blocked = await server.api('POST', '/api/tasks', {
      prompt: 'Blocked, needs a new model',
      dependsOn: [dep.body.id],
    });
    expect(blocked.body.state).toBe('blocked');

    const pinned = await server.api('PATCH', `/api/tasks/${blocked.body.id}`, { model: 'chosen-model' });
    expect(pinned.status).toBe(200);
    expect(pinned.body.state).toBe('blocked'); // still blocked, just re-pointed
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
