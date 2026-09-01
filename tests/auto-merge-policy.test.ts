import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, seedLocalMarkdownTicket, type TestServer } from './helpers.js';
import { verificationCommandSchema } from '../src/config.js';
import type { MirrorInput } from '../src/domain/tasks.js';
import { runMergePolicy } from '../src/execution/merge-policy.js';

/**
 * Issue #381 — automated task completion rewired through the one-merge-policy
 * primitive (ADR-0001, #380): an ordinary `git merge --no-ff` under the base
 * repo's mutex, a deterministic post-merge check on the merged tip (no
 * critic), and `git revert -m 1` + escalate on a red check. There is no
 * freshness gate, no rebase re-entry, and no carry-forward verified-head: a
 * base that moved between verification and merging is normal — the merge
 * commit reconciles it, and the base is never re-verified.
 *
 * HISTORY: `mergePolicyDeps.runPostMergeCheck` (runner.ts) runs the real
 * command verifier with `repoDir: baseDir` — the SAME base repo the merge
 * itself just locked via `withRepoLock` — and that verifier adds its own
 * detached worktree via `Git.addDetachedWorktree`, itself locked. This used
 * to deadlock the Runner forever the first time postMergeCheck ran with a
 * real configured command (confirmed by hand while writing this file).
 * `withRepoLock` (src/execution/repo-lock.ts) is now reentrant on the same
 * repo key, so that self-nesting runs inline instead of hanging — case (a)
 * below drives the real production path end to end to prove it. The direct-
 * `runMergePolicy` post-merge-red/revert cases further down stay as focused,
 * fast coverage of the primitive's revert/escalate behaviour in isolation.
 */

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

const tmpDirs: string[] = [];
const tmpPath = (prefix: string) => {
  const p = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(p);
  return p;
};

/** A throwaway git repo on main with a local-markdown tracker declaration (so
 * the auto-merge close resolves a real no-op adapter). */
function makeRepo(): string {
  const dir = tmpPath('harmonic-auto-merge-');
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  mkdirSync(join(dir, 'docs', 'agents'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'agents', 'issue-tracker.md'), '# Issue tracker: local-markdown\n\nPath: tickets\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

/** A verify command that always passes — a real spawned process, real exit
 * code, run against a real disposable detached worktree by the real command
 * verifier (no side effects on the repo). */
function passingVerifier() {
  return verificationCommandSchema.parse({
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    timeoutSeconds: 30,
  });
}

/**
 * A verify command that PASSES, and on its first run only, advances `main`
 * behind the candidate's back with an unrelated empty commit — modelling a
 * sibling task merging while this one is still verifying. The flag file makes
 * the effect fire once, so a re-run (there should be none) leaves main alone.
 */
function siblingAdvanceVerifier(repo: string, flag: string) {
  return verificationCommandSchema.parse({
    command: process.execPath,
    args: [
      '-e',
      `const fs=require('fs');const cp=require('child_process');` +
        `if(!fs.existsSync(${JSON.stringify(flag)})){` +
        `fs.writeFileSync(${JSON.stringify(flag)},'1');` +
        `cp.execFileSync('git',['-C',${JSON.stringify(repo)},'commit','--allow-empty','-m','sibling advances independently']);}`,
    ],
    timeoutSeconds: 30,
  });
}

/**
 * A verify command that PASSES, and on its first run only, writes CONFLICTING
 * content to `conflict.txt` (a fixed name, distinct from the per-ref impl
 * file) — so merging the candidate branch hits a real content conflict. The
 * flag file makes the effect fire once.
 */
function conflictingSiblingVerifier(repo: string, flag: string) {
  const conflictFile = join(repo, 'conflict.txt');
  return verificationCommandSchema.parse({
    command: process.execPath,
    args: [
      '-e',
      `const fs=require('fs');const cp=require('child_process');` +
        `if(!fs.existsSync(${JSON.stringify(flag)})){` +
        `fs.writeFileSync(${JSON.stringify(flag)},'1');` +
        `fs.writeFileSync(${JSON.stringify(conflictFile)},'sibling version\\n');` +
        `cp.execFileSync('git',['-C',${JSON.stringify(repo)},'add','-A']);` +
        `cp.execFileSync('git',['-C',${JSON.stringify(repo)},'commit','-m','sibling changes conflict.txt']);}`,
    ],
    timeoutSeconds: 30,
  });
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('one merge policy, everywhere (issue #381, ADR-0001)', () => {
  let server: TestServer;
  let wsId: number;
  let ref = 38_100;

  beforeAll(async () => {
    server = await startServer({
      ...stubHarness(),
      defaults: { isolationMode: 'worktree' },
      maxAttempts: 2,
      drive: { continueAttempts: 0, mergeFate: 'auto-merge' },
    });
    wsId = (await server.app.ctx.workspaces.list())[0]!.id;
  });
  afterAll(async () => {
    await server.close();
  });

  const mirroredAfk = (trackerRef: number): MirrorInput => ({
    trackerRef,
    prompt: `ticket ${trackerRef}\n\nbody`,
    workflow: 'implement',
    wayfinderType: null,
    mapRef: null,
    closed: false,
  });

  /** Mirror an afk Task (auto-merge onto main) with its local-markdown ticket
   * committed on main: the ticket file lives in the base repo's checkout, and
   * an in-place merge requires that checkout clean. */
  async function seedAfk(): Promise<{ taskId: number; trackerRef: number }> {
    const trackerRef = ref++;
    const task = await server.app.ctx.tasks.upsertMirrored(mirroredAfk(trackerRef));
    seedLocalMarkdownTicket(task.workingDir, trackerRef, 'closed');
    git(task.workingDir, 'add', '-A');
    git(task.workingDir, 'commit', '-q', '-m', `ticket ${trackerRef}`);
    return { taskId: task.id, trackerRef };
  }

  async function launch(taskId: number): Promise<number> {
    await server.app.ctx.tasks.setState(taskId, 'working');
    return (await server.app.ctx.runner.launchClaimed(taskId)).id;
  }

  async function launchAfk(): Promise<{ taskId: number; attemptId: number; trackerRef: number }> {
    const seeded = await seedAfk();
    return { ...seeded, attemptId: await launch(seeded.taskId) };
  }

  const waitDone = (taskId: number, attemptId: number, opts?: { timeoutMs?: number }) =>
    waitFor(async () => {
      const t = await server.app.ctx.tasks.get(taskId);
      if (t.state === 'escalated') throw new Error(`escalated instead of merging: ${(await server.app.ctx.attempts.get(attemptId)).reason}`);
      return t.state === 'done' ? t : undefined;
    }, opts);
  const waitEscalated = (taskId: number) =>
    waitFor(async () => {
      const t = await server.app.ctx.tasks.get(taskId);
      return t.state === 'escalated' ? t : undefined;
    });

  const timelineFor = async (taskId: number) =>
    (await server.api('GET', `/api/tasks/${taskId}/attempts/timeline`)).body.attempts as Array<{
      number: number;
      state: string;
      steps: Array<{ type: string; state: string; verdict: string | null }>;
    }>;
  const lifecycle = async (attemptId: number): Promise<Array<{ event: string; mechanism?: string; reason?: string; oid?: string; baseBranch?: string }>> =>
    (await server.api('GET', `/api/attempts/${attemptId}/events`)).body.events
      .filter((e: { type: string }) => e.type === 'lifecycle')
      .map((e: { payload: { event: string; mechanism?: string; reason?: string; oid?: string; baseBranch?: string } }) => e.payload);

  it(
    '(a) an afk auto-merge Task with a REAL post-merge check merges as an ordinary merge commit (never a fast-forward), closes the ticket, and does not deadlock',
    async () => {
      const repo = makeRepo();
      // A real configured verify command AND postMergeCheck: true drives the
      // production `runPostMergeCheck` → `runCommandVerifier` path under the
      // real merge lock — the exact combination that used to deadlock the
      // Runner forever before `withRepoLock` became reentrant.
      await server.app.ctx.workspaces.update(wsId, { workingDir: repo, verificationCommand: [passingVerifier()] });
      await server.app.ctx.settingsStore.updateGlobal({
        merge: { postMergeCheck: true },
        drive: { prompt: JSON.stringify({ writeFiles: { 'impl-{ref}.txt': 'implementation {ref}\n' }, mcpFinish: true }) },
      });

      const { taskId, attemptId, trackerRef } = await launchAfk();
      // A generous but bounded wait: a regression back to the deadlock must
      // surface as a `waitFor` timeout (then the `it` timeout below as a
      // backstop), never as the test suite hanging forever.
      const task = await waitDone(taskId, attemptId, { timeoutMs: 20_000 });
      expect(task.state).toBe('done');

      // A REAL merge commit: main's tip has two parents and appears in the
      // branch's merge history — the inverse of the old fast-forward assertion.
      expect(git(repo, 'rev-parse', 'main^2')).toMatch(/^[0-9a-f]{40}$/);
      expect(Number(git(repo, 'rev-list', '--count', '--merges', 'main'))).toBeGreaterThanOrEqual(1);
      expect(git(repo, 'show', `main:impl-${trackerRef}.txt`)).toBe(`implementation ${trackerRef}`);

      // Both the pre-merge candidate verification AND the post-merge check on
      // the merged tip actually ran — the check is no longer skipped/hung.
      const events = await lifecycle(attemptId);
      const commandVerifications = events.filter((e) => e.event === 'verification' && e.mechanism === 'command');
      expect(commandVerifications).toHaveLength(2);
      expect(events).toContainEqual(expect.objectContaining({ event: 'merged', baseBranch: 'main' }));
    },
    30_000,
  );

  it('(b) a sibling advancing the base mid-verification does not trigger re-verification — the candidate still merges as an ordinary merge commit', async () => {
    const repo = makeRepo();
    const flag = join(tmpPath('harmonic-auto-merge-flag-'), 'advanced');
    await server.app.ctx.workspaces.update(wsId, { workingDir: repo, verificationCommand: [siblingAdvanceVerifier(repo, flag)] });
    // Isolate the assertion to the pre-merge verification pass: disable the
    // post-merge check here (covered directly against runMergePolicy below —
    // see the file-level SIMPLIFICATION note).
    await server.app.ctx.settingsStore.updateGlobal({
      merge: { postMergeCheck: false },
      drive: { prompt: JSON.stringify({ writeFiles: { 'impl-{ref}.txt': 'implementation {ref}\n' }, mcpFinish: true }) },
    });

    const { taskId, attemptId, trackerRef } = await launchAfk();
    const task = await waitDone(taskId, attemptId);
    expect(task.state).toBe('done');

    // main really did advance independently during verification...
    const events = await lifecycle(attemptId);
    const commandVerifications = events.filter((e) => e.event === 'verification' && e.mechanism === 'command');
    // ...yet the candidate's verification ran exactly ONCE — no re-verification
    // of a rebased/replayed tree, no `rebase-required`/`moving-base` events.
    expect(commandVerifications).toHaveLength(1);
    expect(events.map((e) => e.event)).not.toContain('rebase-required');
    expect(events.map((e) => e.event)).not.toContain('moving-base');

    // The ordinary merge commit reconciled the moved base and the candidate.
    expect(git(repo, 'rev-parse', 'main^2')).toMatch(/^[0-9a-f]{40}$/);
    expect(Number(git(repo, 'rev-list', '--count', '--merges', 'main'))).toBeGreaterThanOrEqual(1);
    expect(git(repo, 'log', '--format=%s', 'main')).toContain('sibling advances independently');
    expect(git(repo, 'show', `main:impl-${trackerRef}.txt`)).toBe(`implementation ${trackerRef}`);

    // Only the Attempt-start Rebase Task ran — no second (completion-rebase)
    // row: that machinery no longer exists.
    const timeline = await timelineFor(taskId);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.steps.filter((t) => t.type === 'rebase')).toHaveLength(1);
  });

  it('(d) conflictResolveTurns is wired from the task setting through to the merge policy: 0 turns escalates immediately on a real conflict', async () => {
    const repo = makeRepo();
    const flag = join(tmpPath('harmonic-auto-merge-conflict-flag-'), 'advanced');
    await server.app.ctx.workspaces.update(wsId, {
      workingDir: repo,
      verificationCommand: [conflictingSiblingVerifier(repo, flag)],
      conflictResolveTurns: 0,
    });
    await server.app.ctx.settingsStore.updateGlobal({
      merge: { postMergeCheck: false },
      drive: {
        prompt: JSON.stringify({
          writeFiles: { 'conflict.txt': 'agent version\n', 'impl-{ref}.txt': 'implementation {ref}\n' },
          mcpFinish: true,
        }),
      },
    });

    const { taskId, attemptId } = await launchAfk();
    const task = await waitEscalated(taskId);
    expect(task.state).toBe('escalated');

    // Task.escalationReason carries settleEscalated's "escalated to human: "
    // prefix; the lifecycle event carries the raw merge-policy message. Both
    // must name the 0-turn budget in plain language.
    expect(task.escalationReason).toMatch(/hit conflicts and automated resolution is disabled \(0 resolve turns\)/);
    expect(task.escalationReason).not.toMatch(/<<<<<<<|CONFLICT/);

    // Nothing merged: the conflicted merge was aborted, main is still just the
    // sibling's own commit.
    expect(git(repo, 'log', '--merges', 'main')).toBe('');
    expect(git(repo, 'show', 'main:conflict.txt')).toBe('sibling version');

    const events = await lifecycle(attemptId);
    const escalation = events.find((e) => e.event === 'escalated');
    expect(escalation?.reason).toMatch(/hit conflicts and automated resolution is disabled \(0 resolve turns\)/);
    expect(escalation?.reason).not.toMatch(/<<<<<<<|CONFLICT/);
  });
});

/**
 * The post-merge check, driven directly against the real `runMergePolicy`
 * primitive (src/execution/merge-policy.ts) rather than through the Runner —
 * see the file-level SIMPLIFICATION note for why. `resolveConflictTurn` and
 * `escalate` are stubbed (ADR-0001 documents both as injected, variable
 * behaviour); `runPostMergeCheck` is a plain function under test control, so
 * these cases isolate exactly the merge / post-merge-check / revert sequence
 * against a REAL git repo with a REAL `git merge --no-ff` and a REAL
 * `git revert -m 1` — only the "run some verify commands" mechanics are
 * swapped out for a stub that doesn't hit the runner's deadlock.
 */
describe('post-merge check (issue #381, ADR-0001) — direct against runMergePolicy', () => {
  function makeMergeableRepo(): { repo: string; taskBranch: string } {
    const repo = makeRepo();
    const taskBranch = 'harmonic/task-1';
    git(repo, 'checkout', '-b', taskBranch);
    writeFileSync(join(repo, 'impl.txt'), 'implementation\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'implementation');
    git(repo, 'checkout', 'main');
    return { repo, taskBranch };
  }

  it('runs the post-merge check against the merged tip and merges as an ordinary merge commit', async () => {
    const { repo, taskBranch } = makeMergeableRepo();
    const checkedOids: string[] = [];

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch, conflictResolveTurns: 0, postMergeCheck: true },
      {
        resolveConflictTurn: async () => {},
        runPostMergeCheck: async (mergeOid) => {
          checkedOids.push(mergeOid);
          return { pass: true, output: '' };
        },
        escalate: async () => {},
      },
    );

    expect(outcome.kind).toBe('merged');
    expect(git(repo, 'rev-parse', 'main^2')).toMatch(/^[0-9a-f]{40}$/);
    expect(Number(git(repo, 'rev-list', '--count', '--merges', 'main'))).toBeGreaterThanOrEqual(1);
    expect(git(repo, 'show', 'main:impl.txt')).toBe('implementation');
    // The post-merge check ran exactly once, against the merge commit that
    // actually landed on main — never the pre-merge candidate tip.
    expect(checkedOids).toEqual([git(repo, 'rev-parse', 'main')]);
  });

  it('reverts the merge and escalates with a plain reason when the post-merge check goes red', async () => {
    const { repo, taskBranch } = makeMergeableRepo();
    let escalated: string | null = null;

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch, conflictResolveTurns: 0, postMergeCheck: true },
      {
        resolveConflictTurn: async () => {},
        runPostMergeCheck: async () => ({ pass: false, output: 'the build failed\n' }),
        escalate: async (reason) => {
          escalated = reason;
        },
      },
    );

    expect(outcome.kind).toBe('escalated');
    if (outcome.kind === 'escalated') expect(outcome.reason).toBe('post-merge-red');
    expect(escalated).toMatch(/post-merge check/);
    expect(escalated).toMatch(/reverted/);
    expect(escalated).not.toMatch(/<<<<<<<|CONFLICT/);

    // The merge commit is still in history (it happened) — a revert commit
    // now sits on top of it, so the base's content is unaffected.
    expect(Number(git(repo, 'rev-list', '--count', '--merges', 'main'))).toBeGreaterThanOrEqual(1);
    expect(git(repo, 'log', '-1', '--format=%s', 'main')).toMatch(/^Revert /);
    expect(() => git(repo, 'show', 'main:impl.txt')).toThrow();
  });
});
