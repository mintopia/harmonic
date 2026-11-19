import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEpicEngineHarness, epicWorkflow, git, EPIC_REF, type EpicEngineHarness, WORKFLOW_NAME } from './fixtures/epic-engine-harness.js';

describe('Epic workflow passes', () => {
  let harness: EpicEngineHarness;
  afterEach(() => harness.dispose());

  const stepRows = async () => (await harness.stepRuns.listForOwner({ workspaceId: harness.workspaceId, epicRef: EPIC_REF })).map((row) => [row.stepId, row.attempt, row.outcome]);
  const epicAttempts = () => harness.attempts.listForEpic({ workspaceId: harness.workspaceId, epicRef: EPIC_REF });

  it('runs no agent on a clean first pass and skips resolve on Attempt 1', async () => {
    harness = await createEpicEngineHarness({ workflow: epicWorkflow('true') });
    const outcome = await harness.submit();

    expect(outcome.status).toBe('integrated');
    expect(harness.driveCalls).toBe(0);
    expect((await stepRows()).filter(([step]) => step === 'resolve')).toEqual([['resolve', 1, 'skipped']]);
  });

  it('resolves on pass 2 after a failed verify, in one Epic Attempt', async () => {
    harness = await createEpicEngineHarness({
      workflow: epicWorkflow('test -f fixed.txt'),
      drive: async (req) => {
        writeFileSync(join(req.cwd, 'fixed.txt'), 'fixed\n');
        git(req.cwd, 'add', '.');
        git(req.cwd, '-c', 'user.name=A', '-c', 'user.email=a@example.com', 'commit', '-qm', 'fix');
        return { output: '', permissionRequests: [] };
      },
    });
    const outcome = await harness.submit();

    expect(outcome.status).toBe('integrated');
    expect(harness.driveCalls).toBe(1);
    expect(await stepRows()).toEqual(expect.arrayContaining([['resolve', 1, 'skipped'], ['verify', 1, 'fail'], ['resolve', 2, 'pass'], ['verify', 2, 'pass']]));
    expect(await epicAttempts()).toHaveLength(1);
    expect(git(harness.repoDir, 'show', 'main:fixed.txt')).toBe('fixed');
  });

  it('escalates the Epic when attempts are exhausted, never merging', async () => {
    harness = await createEpicEngineHarness({ workflow: epicWorkflow('false') });
    const baseBefore = git(harness.repoDir, 'rev-parse', 'main');

    const outcome = await harness.submit();

    expect(outcome.status).toBe('escalated');
    expect(harness.escalations).toHaveLength(1);
    expect(harness.escalations[0]).toContain('workflow attempts exhausted after 2');
    expect(harness.recorded).toEqual([]);
    expect(git(harness.repoDir, 'rev-parse', 'main')).toBe(baseBefore);
    const attempts = await epicAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ state: 'escalated' });
    expect(await harness.submit()).toMatchObject({ status: 'escalated' });
    expect(harness.escalations).toHaveLength(1);
  });

  it('starts a new run with operator guidance as feedback after an escalation', async () => {
    harness = await createEpicEngineHarness({ workflow: epicWorkflow('test -f ../../ok') });
    expect((await harness.submit()).status).toBe('escalated');
    writeFileSync(join(harness.root, 'ok'), '');

    harness.resume('mind the export flag');
    const outcome = await harness.submit();

    expect(outcome.status).toBe('integrated');
    const attempts = await epicAttempts();
    expect(attempts.map((attempt) => [attempt.state, attempt.feedback])).toEqual([['escalated', null], ['passed', 'mind the export flag']]);
  });
});

describe('Epic verifies and merges through the engine (real git)', () => {
  let harness: EpicEngineHarness;
  afterEach(() => harness.dispose());

  it('verifies a two-member Epic and merges it into the base with a merge commit', async () => {
    harness = await createEpicEngineHarness({ workflow: epicWorkflow('test -f member-1.txt && test -f member-2.txt') });
    const epicTip = git(harness.repoDir, 'rev-parse', 'epic/42');
    const baseBefore = git(harness.repoDir, 'rev-parse', 'main');

    const outcome = await harness.submit();

    const mergeCommit = git(harness.repoDir, 'rev-parse', 'main');
    expect(outcome).toEqual({ status: 'integrated', oid: mergeCommit });
    expect(mergeCommit).not.toBe(baseBefore);
    expect(git(harness.repoDir, 'rev-list', '--parents', '-n', '1', 'main').split(' ')).toEqual([mergeCommit, baseBefore, epicTip]);
    expect(git(harness.repoDir, 'show', 'main:member-1.txt')).toBe('member 1');
    expect(git(harness.repoDir, 'show', 'main:member-2.txt')).toBe('member 2');
    expect(git(harness.repoDir, 'branch', '--show-current')).toBe('main');
    expect(harness.recorded).toEqual([{ mergeCommit, memberRefs: ['43', '44'] }]);
    expect(harness.closed).toEqual(['42']);
    expect(harness.escalations).toEqual([]);
  });

  it('pins the workflow version and records one passed Epic Attempt with step runs on the Epic', async () => {
    harness = await createEpicEngineHarness({ workflow: epicWorkflow('true') });
    await harness.submit();

    expect(harness.pinned.get(EPIC_REF)).toBe(`${WORKFLOW_NAME}@1`);
    const attempts = await harness.attempts.listForEpic({ workspaceId: harness.workspaceId, epicRef: EPIC_REF });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ state: 'passed', branch: 'epic/42', baseBranch: 'main' });
    const rows = await harness.stepRuns.listForOwner({ workspaceId: harness.workspaceId, epicRef: EPIC_REF });
    expect(rows.map((row) => [row.stepId, row.outcome])).toEqual([['resolve', 'skipped'], ['verify', 'pass'], ['merge', 'pass'], ['close-ticket', 'pass'], ['cleanup', 'pass']]);
  });
});
