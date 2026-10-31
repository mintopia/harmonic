import { afterEach, describe, expect, it } from 'vitest';
import { createEpicEngineHarness, epicWorkflow, git, EPIC_REF, WORKFLOW_NAME, type EpicEngineHarness } from './fixtures/epic-engine-harness.js';

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
