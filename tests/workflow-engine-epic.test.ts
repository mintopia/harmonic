import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { epics } from '../src/db/schema.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { WorkflowStepRunStore, type StepRunOwner } from '../src/domain/workflow-step-runs.js';
import { baselineConfig } from '../src/config.js';
import { WorkflowEngine, type EpicSubject, type WorkflowEngineDeps } from '../src/execution/workflow-engine.js';
import { bundledEnginePrompts } from '../src/domain/bundled-prompts.js';
import { createChildProcessSpawn } from '../src/verification/command-verifier.js';
import { trackerRef } from '../src/tracker/adapter.js';
import { seedWorkspace, testSpawnProcessGroup } from './helpers.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('WorkflowEngine on an Epic subject', () => {
  let dir: string;
  let repo: string;
  let db: AsyncDbHandle;
  let workspaceId: number;
  let escalations: string[];
  let completions: number;
  let changed: StepRunOwner[];
  let workflow: string;
  const epicRef = trackerRef(40);

  const epicFlow = (verify: string): string => `name: epicflow
description: test
subject: epic
steps:
  - attempts:
      max: 2
      steps:
        - id: resolve
          if: \${{ attempt.number > 1 }}
          run: echo resolving
        - id: verify
          run: ${verify}
`;

  const subject = (): EpicSubject => ({
    epicRef, workspaceId, workflowRef: 'epicflow@1', workflowVars: null, prompt: 'integrate', feedback: null, trackerTitle: 'Epic', trackerBody: '', trackerLabels: [], trackerRef: epicRef, origin: 'mirrored', workingDir: repo,
  });
  const owner = (): StepRunOwner => ({ workspaceId, epicRef });
  const engine = (over: Partial<WorkflowEngineDeps<EpicSubject>> = {}): WorkflowEngine<EpicSubject> =>
    new WorkflowEngine<EpicSubject>({
      library: { getVersion: async (name, version) => ({ name, description: '', subject: 'epic' as const, text: workflow, version }) },
      stepRuns: new WorkflowStepRunStore(db),
      spawn: createChildProcessSpawn(testSpawnProcessGroup),
      secrets: async () => ({}),
      cwdFor: () => repo,
      baseBranchFor: async () => 'main',
      agent: { drive: { run: async () => { throw new Error('no agent'); } }, getConfig: () => baselineConfig(), prompts: bundledEnginePrompts, route: async () => { throw new Error('no route'); }, resolveOption: async () => { throw new Error('no option'); }, resolvePrompt: async (text) => text, promptFields: async () => ({ taskId: '', skill: '', ref: '', url: '', title: '', description: '' }) },
      escalate: async (_s, _r, reason) => { escalations.push(reason); },
      complete: async () => { completions += 1; },
      onStepChanged: (o) => changed.push(o),
      ...over,
    });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-wf-epic-'));
    repo = join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    db = await openAsyncDb(dir);
    workspaceId = await seedWorkspace(db, repo);
    await db.write((d) => d.insert(epics).values({ workspaceId, trackerRef: epicRef, kind: 'epic', state: 'open' } as typeof epics.$inferInsert).run());
    escalations = [];
    completions = 0;
    changed = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('records step runs against the Epic owner and skips resolve on pass 1', async () => {
    workflow = epicFlow('"true"');
    const run = await new AttemptStore(db).createForEpic({ workspaceId, epicRef });
    await engine().run(subject(), run);
    const rows = await new WorkflowStepRunStore(db).listForOwner(owner());
    expect(rows.map((r) => [r.stepId, r.outcome, r.attempt])).toEqual([['resolve', 'skipped', 1], ['verify', 'pass', 1]]);
    expect(rows.every((r) => r.taskId === null && r.workspaceId === workspaceId && r.epicRef === epicRef)).toBe(true);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((o) => 'epicRef' in o && o.epicRef === epicRef)).toBe(true);
    expect(completions).toBe(1);
    expect(escalations).toEqual([]);
  });

  it('escalates when verify fails on every pass, running resolve on pass 2', async () => {
    workflow = epicFlow('"exit 1"');
    const run = await new AttemptStore(db).createForEpic({ workspaceId, epicRef });
    await engine().run(subject(), run);
    const rows = await new WorkflowStepRunStore(db).listForOwner(owner());
    expect(rows.map((r) => [r.stepId, r.outcome, r.attempt])).toEqual([['resolve', 'skipped', 1], ['verify', 'fail', 1], ['resolve', 'pass', 2], ['verify', 'fail', 2]]);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toContain('workflow attempts exhausted after 2');
    expect(completions).toBe(0);
  });

  it('resumes from the Epic owner without re-running finished steps', async () => {
    workflow = epicFlow('"true"');
    const store = new WorkflowStepRunStore(db);
    const run = await new AttemptStore(db).createForEpic({ workspaceId, epicRef });
    const done = await store.start({ ...owner(), workflowRef: 'epicflow@1', stepId: 'resolve', position: 0, action: 'run', attempt: 1 });
    await store.finish(done.id, { outcome: 'skipped', outputs: { stdout: '', exitCode: null }, summary: 'skipped' });
    expect([...(await store.latestByStep(owner(), 'epicflow@1')).keys()]).toEqual(['resolve']);
    await engine().run(subject(), run, true);
    const rows = await store.listForOwner(owner());
    expect(rows.filter((r) => r.stepId === 'resolve')).toHaveLength(1);
    expect(rows.find((r) => r.stepId === 'verify')?.outcome).toBe('pass');
    expect(await store.listForOwner({ workspaceId, epicRef: trackerRef(41) })).toEqual([]);
  });

  it('accepts a failed step by owner', async () => {
    workflow = epicFlow('"exit 1"');
    const store = new WorkflowStepRunStore(db);
    const run = await new AttemptStore(db).createForEpic({ workspaceId, epicRef });
    await engine().run(subject(), run);
    await engine().acceptFailed(subject());
    expect((await store.latestByStep(owner(), 'epicflow@1')).get('verify')?.outcome).toBe('pass');
  });

  it('rejects a step run with no owner or two owners', async () => {
    const sqlite = createClient({ url: `file:${join(dir, 'harmonic.db')}` });
    const insert = (cols: string, vals: string) => sqlite.execute(`INSERT INTO workflow_step_runs (${cols}, workflow_ref, step_id, position, action, started_at) VALUES (${vals}, 'w@1', 's', 0, 'run', 1)`);
    await expect(insert('task_id', 'NULL')).rejects.toThrow();
    await expect(insert('task_id, workspace_id, epic_ref', `1, ${workspaceId}, '${epicRef}'`)).rejects.toThrow();
    sqlite.close();
  });
});
