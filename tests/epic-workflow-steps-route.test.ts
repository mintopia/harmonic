import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkflowStepRunStore } from '../src/domain/workflow-step-runs.js';
import { trackerRef } from '../src/tracker/adapter.js';
import { startServer, type TestServer } from './helpers.js';

describe('GET /api/workspaces/:workspaceId/epics/:epicRef/workflow-steps', () => {
  let server: TestServer;
  let workspaceId: number;

  beforeAll(async () => {
    server = await startServer();
    workspaceId = (await server.app.ctx.workspaces.list())[0]!.id;
  });
  afterAll(async () => server.close());

  const url = (ref: number) => `/api/workspaces/${workspaceId}/epics/${ref}/workflow-steps`;

  it('is empty and unpinned for an Epic that has not run on the engine', async () => {
    await server.app.ctx.tasks.syncEpics(workspaceId, [{ ref: trackerRef(801), kind: 'epic' }]);
    const { status, body } = await server.api('GET', url(801));
    expect(status).toBe(200);
    expect(body).toMatchObject({ workflowRef: null, workflowChosen: null, steps: [] });
  });

  it('returns the pinned workflow and its step runs next to an Epic Attempt row', async () => {
    const ref = trackerRef(802);
    await server.app.ctx.tasks.syncEpics(workspaceId, [{ ref, kind: 'epic' }]);
    const epicEntry = server.app.ctx.workflows.list().find((w) => w.subject === 'epic')!;
    const workflowRef = `${epicEntry.name}@${epicEntry.version}`;
    await server.app.ctx.tasks.setEpicWorkflowRef(workspaceId, ref, workflowRef);
    await server.app.ctx.attempts.createForEpic({ workspaceId, epicRef: ref });
    const store = new WorkflowStepRunStore(server.app.ctx.asyncDb);
    const owner = { workspaceId, epicRef: ref };
    const record = async (workflowRef: string, stepId: string, position: number, action: string, attempt: number | null, outcome: 'pass' | 'fail' | 'skipped', summary: string) => {
      const row = await store.start({ ...owner, workflowRef, stepId, position, action, attempt });
      await store.finish(row.id, { outcome, outputs: { stdout: '', exitCode: null }, summary });
    };
    await record(workflowRef, 'resolve', 0, 'agent', 1, 'skipped', 'if: false');
    await record(workflowRef, 'verify', 1, 'command', 1, 'fail', 'exit 1');
    await record(workflowRef, 'resolve', 0, 'agent', 2, 'pass', '');
    await record('epic@0', 'stale', 0, 'run', null, 'pass', '');

    const { status, body } = await server.api('GET', url(802));
    expect(status).toBe(200);
    expect(body.workflowRef).toBe(workflowRef);
    expect(body.workflowChosen).toBe('global');
    expect(body.outline.length).toBeGreaterThan(0);
    expect(body.steps.map((s: { stepId: string; attempt: number; outcome: string }) => [s.stepId, s.attempt, s.outcome])).toEqual([
      ['resolve', 1, 'skipped'],
      ['verify', 1, 'fail'],
      ['resolve', 2, 'pass'],
    ]);
    const attempts = await server.api('GET', `/api/workspaces/${workspaceId}/epics/802/attempts`);
    expect(attempts.body.attempts).toHaveLength(1);
    expect(attempts.body.attempts[0]).toMatchObject({ stepRuns: [] });
    expect(attempts.body.attempts[0]).not.toHaveProperty('steps');
    expect(attempts.body.attempts[0]).not.toHaveProperty('verificationAttempts');
  });

  it('404s for an unknown Workspace', async () => {
    const { status } = await server.api('GET', '/api/workspaces/999999/epics/801/workflow-steps');
    expect(status).toBe(404);
  });
});
