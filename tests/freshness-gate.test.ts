import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, seedLocalMarkdownTicket, type TestServer } from './helpers.js';
import { verificationCommandSchema, verificationCriticSchema } from '../src/config.js';
import type { CriticHarnessDrive } from '../src/verification/critic.js';
import type { MirrorInput } from '../src/domain/tasks.js';
import { mergeJournal, runFacts, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * Issue #313 — the merging freshness gate (ADR-0041), end to end through the
 * real Runner over the stub harness against a real git Workspace:
 *
 *  - the base advances between verification and merging → merging refuses the
 *    stale verdict, a Rebase Task re-bases the ticket branch, verification
 *    re-runs at the new head, and the merge asserts the NEW SHA — all on the
 *    same Attempt and the same Session, no counter increment;
 *  - an operator Accept on an escalated ticket whose base moved since
 *    verification refuses (409, merging abandoned) rather than merging what
 *    nobody verified.
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
  const dir = tmpPath('harmonic-freshness-');
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

/** Advance main in the base repo's own (clean, checked-out) working tree. */
function advanceMain(repo: string, file: string, content: string): string {
  writeFileSync(join(repo, file), content);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'main advances independently');
  return git(repo, 'rev-parse', 'main');
}

/**
 * A verification command that PASSES, and on its first run only advances main
 * behind verification's back — the exact verify→merge window the gate exists
 * for. The flag file makes the re-verification leave main alone, so the
 * re-entry converges.
 */
function baseMovingVerifier(repo: string, flag: string) {
  return verificationCommandSchema.parse({
    command: process.execPath,
    args: [
      '-e',
      `const fs=require('fs');const cp=require('child_process');` +
        `if(!fs.existsSync(${JSON.stringify(flag)})){` +
        `fs.writeFileSync(${JSON.stringify(flag)},'1');` +
        `cp.execFileSync('git',['-C',${JSON.stringify(repo)},'commit','--allow-empty','-m','main advances during verification']);}`,
    ],
    timeoutSeconds: 30,
  });
}

/**
 * A verifier that PASSES and, on its first run only, advances main with a
 * change to `conflict.txt` that COLLIDES with the candidate's own — so the
 * completion rebase of the verified candidate onto the moved base hits a real
 * content conflict (ADR-0046). The flag file makes re-runs leave main alone.
 */
function conflictingVerifier(repo: string, flag: string) {
  const conflictFile = join(repo, 'conflict.txt');
  return verificationCommandSchema.parse({
    command: process.execPath,
    args: [
      '-e',
      `const fs=require('fs');const cp=require('child_process');` +
        `if(!fs.existsSync(${JSON.stringify(flag)})){` +
        `fs.writeFileSync(${JSON.stringify(flag)},'1');` +
        `fs.writeFileSync(${JSON.stringify(conflictFile)},'main version\\n');` +
        `cp.execFileSync('git',['-C',${JSON.stringify(repo)},'add','-A']);` +
        `cp.execFileSync('git',['-C',${JSON.stringify(repo)},'commit','-m','main changes conflict.txt']);}`,
    ],
    timeoutSeconds: 30,
  });
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('merging freshness gate (issue #313, ADR-0041)', () => {
  let server: TestServer;
  let wsId: number;
  let ref = 31_300;
  // The fake critic's verdict and its per-Run invocation count (ADR-0046): the
  // critic must review the candidate ONCE, never per rebase re-entry.
  let criticCalls = 0;
  const criticDrive: CriticHarnessDrive = {
    run: async () => {
      criticCalls += 1;
      return { output: JSON.stringify({ verdict: 'pass', summary: 'looks correct' }), permissionRequests: [] };
    },
  };

  beforeAll(async () => {
    server = await startServer(
      {
        ...stubHarness(),
        defaults: { isolationMode: 'worktree' },
        maxAttempts: 2,
        drive: { continueAttempts: 0, mergeFate: 'auto-merge' },
      },
      { criticDrive },
    );
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
   * committed on main: the ticket file lives in the base repo's checkout, and an
   * in-place merge requires that checkout clean. Seeded already `closed` so the
   * post-merge close rewrites it byte-identically (the helper's fixed point) and
   * a second Run's merge still finds main clean. */
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

  async function launchAfk(): Promise<{ taskId: number; runId: number; trackerRef: number }> {
    const seeded = await seedAfk();
    return { ...seeded, runId: await launch(seeded.taskId) };
  }

  const timelineFor = async (taskId: number) =>
    (await server.api('GET', `/api/tasks/${taskId}/attempts`)).body.attempts as Array<{
      number: number;
      state: string;
      tasks: Array<{ type: string; state: string; verdict: string | null }>;
    }>;
  const lifecycle = async (runId: number): Promise<Array<{ event: string; reason?: string }>> =>
    (await server.api('GET', `/api/runs/${runId}/events`)).body.events
      .filter((e: { type: string }) => e.type === 'lifecycle')
      .map((e: { payload: { event: string; reason?: string } }) => e.payload);

  it('base moved between verify and merge: rebase + re-verify on the same Attempt and Session, then merge asserting the new SHA', async () => {
    const repo = makeRepo();
    const flag = join(tmpPath('harmonic-freshness-flag-'), 'advanced');
    await server.app.ctx.workspaces.update(wsId, { workingDir: repo, verificationCommand: [baseMovingVerifier(repo, flag)] });
    await server.app.ctx.configStore.update({
      drive: { prompt: JSON.stringify({ writeFiles: { 'impl-{ref}.txt': 'implementation {ref}\n' }, mcpFinish: true }) },
    });
    const sessionsBefore = (await server.app.ctx.asyncDb.read((d) => d.select().from(sessions).all())).length;

    const { taskId, runId, trackerRef } = await launchAfk();
    const task = await waitFor(async () => {
      const t = await server.app.ctx.tasks.get(taskId);
      if (t.state === 'escalated') throw new Error(`escalated instead of merging: ${(await server.app.ctx.runs.get(runId)).reason}`);
      return t.state === 'done' ? t : undefined;
    });
    expect(task.state).not.toBe('escalated');
    expect(existsSync(flag)).toBe(true); // the verifier really did move main

    // main = the rebased implementation, fast-forwarded on top of the commit
    // that merged mid-verification — no merge commit.
    expect(git(repo, 'log', '--merges', 'main')).toBe('');
    expect(git(repo, 'log', '--format=%s', '-2', 'main')).toBe(
      ['stub implementation', 'main advances during verification'].join('\n'),
    );
    expect(git(repo, 'show', `main:impl-${trackerRef}.txt`)).toBe(`implementation ${trackerRef}`);
    const run = await server.app.ctx.runs.get(runId);
    expect(run.candidateOid).toBe(git(repo, 'rev-parse', 'main')); // the merge asserted the NEW SHA

    // Same Attempt, same Session: the counter stayed at 1, no corrective turn
    // ran, and no new harness Session was spawned for the re-entry.
    expect(run.attempt).toBe(1);
    const sessionsAfter = (await server.app.ctx.asyncDb.read((d) => d.select().from(sessions).all())).length;
    expect(sessionsAfter - sessionsBefore).toBe(1);
    const timeline = await timelineFor(taskId);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.state).toBe('passed');
    expect(timeline[0]!.tasks.map((t) => `${t.type}:${t.state}`)).toEqual([
      'rebase:passed',
      'implementation:passed',
      'verification:passed',
      'rebase:passed',
      'verification:passed',
    ]);

    const events = await lifecycle(runId);
    expect(events.filter((e) => e.event === 'rebase-required')).toEqual([
      { event: 'rebase-required', reason: "base 'main' advanced after verification" },
    ]);
    expect(events.filter((e) => e.event === 'verification')).toHaveLength(2);
    expect(events.map((e) => e.event)).not.toContain('escalated');

    // Moving-base observability (ADR-0046, #368): the single rebase re-entry emits
    // one quiet per-retry event carrying its attempt index, and the completion
    // loop records one terminal run-fact with the final count on exit.
    const movingBase = events.filter((e) => e.event === 'moving-base') as Array<{ event: string; attempt: number; of: number }>;
    expect(movingBase).toEqual([{ event: 'moving-base', attempt: 1, of: 5 }]);
    const facts = await server.app.ctx.asyncDb.read((d) => d.select().from(runFacts).where(eq(runFacts.runId, runId)).all());
    const movingBaseFacts = facts.filter((f) => f.type === 'moving-base');
    expect(movingBaseFacts).toHaveLength(1);
    expect(JSON.parse(movingBaseFacts[0]!.payload)).toEqual({ retries: 1 });
  });

  it('two afk worktree Runs merging concurrently on one base: the second is refused stale at the merge, rebases + re-verifies, then merges its own SHA — no unverified merge commit', async () => {
    const repo = makeRepo();
    await server.app.ctx.workspaces.update(wsId, {
      workingDir: repo,
      verificationCommand: [verificationCommandSchema.parse({ command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutSeconds: 30 })],
    });
    await server.app.ctx.configStore.update({
      drive: { prompt: JSON.stringify({ writeFiles: { 'impl-{ref}.txt': 'implementation {ref}\n' }, mcpFinish: true }) },
    });
    // Seed both tickets first so neither launch moves main under the other's fork.
    const seededA = await seedAfk();
    const seededB = await seedAfk();
    const countBefore = Number(git(repo, 'rev-list', '--count', 'main'));
    const [runA, runB] = await Promise.all([launch(seededA.taskId), launch(seededB.taskId)]);
    const a = { ...seededA, runId: runA };
    const b = { ...seededB, runId: runB };
    const completed = (taskId: number) =>
      waitFor(async () => {
        const t = await server.app.ctx.tasks.get(taskId);
        if (t.state === 'escalated') {
          const runs = await server.app.ctx.runs.listForTask(taskId);
          throw new Error(`task ${taskId} escalated instead of merging: ${runs.map((r) => r.reason).join(' | ')}`);
        }
        return t.state === 'done' ? t : undefined;
      });
    await completed(a.taskId);
    await completed(b.taskId);

    // Two fast-forwards, never a merge commit: main's tip IS one Run's verified
    // SHA and its parent the other's.
    expect(Number(git(repo, 'rev-list', '--count', 'main')) - countBefore).toBe(2);
    expect(git(repo, 'log', '--merges', 'main')).toBe('');
    expect(git(repo, 'show', `main:impl-${a.trackerRef}.txt`)).toBe(`implementation ${a.trackerRef}`);
    expect(git(repo, 'show', `main:impl-${b.trackerRef}.txt`)).toBe(`implementation ${b.trackerRef}`);
    const [ra, rb] = await Promise.all([server.app.ctx.runs.get(a.runId), server.app.ctx.runs.get(b.runId)]);
    expect([ra.candidateOid, rb.candidateOid].sort()).toEqual([git(repo, 'rev-parse', 'main'), git(repo, 'rev-parse', 'main~1')].sort());

    // Both stayed on Attempt 1; the one refused stale re-entered rebase+verify
    // on that Attempt (a second passed rebase + verification row).
    expect(ra.attempt).toBe(1);
    expect(rb.attempt).toBe(1);
    const timelines = [await timelineFor(a.taskId), await timelineFor(b.taskId)];
    const shapes = timelines.map((t) => t[0]!.tasks.map((x) => `${x.type}:${x.state}`).join(',')).sort();
    expect(shapes).toEqual([
      'rebase:passed,implementation:passed,verification:passed',
      'rebase:passed,implementation:passed,verification:passed,rebase:passed,verification:passed',
    ]);
  });

  it('operator Accept on an escalated ticket whose base moved non-conflictingly auto-rebases and merges, without re-verifying (ADR-0043)', async () => {
    const repo = makeRepo();
    // A verifier that fails: both attempts fail, so the ticket escalates with a
    // real commit as its verified head — Accept has work to merge.
    await server.app.ctx.workspaces.update(wsId, {
      workingDir: repo,
      verificationCommand: [verificationCommandSchema.parse({ command: process.execPath, args: ['-e', 'process.exit(1)'], timeoutSeconds: 30 })],
    });

    // A native worktree Run: its prompt IS the stub scenario.
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { 'impl-native.txt': 'implementation\n' } }),
    });
    expect(created.status).toBe(201);
    const taskId: number = created.body.id;
    const started = await server.api('POST', `/api/tasks/${taskId}/run`);
    expect(started.status).toBe(201);
    const runId: number = started.body.id;
    const escalated = await waitFor(async () => {
      const t = (await server.api('GET', `/api/tasks/${taskId}`)).body;
      return t.state === 'escalated' ? t : undefined;
    });
    expect(escalated.escalationReason).toMatch(/attempt 2 of 2 failed/);
    const verified = (await server.app.ctx.runs.get(runId)).candidateOid;
    expect(verified).toMatch(/^[0-9a-f]{40}$/);

    // The base moves non-conflictingly while the ticket sits escalated — the
    // common case during the operator's review delay.
    const mainTip = advanceMain(repo, 'other.txt', 'someone else merged\n');

    const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ state: 'done', escalationReason: null });

    // main now carries BOTH the independent advance and the replayed
    // implementation, merged as a fast-forward (no merge commit).
    expect(git(repo, 'rev-parse', 'main')).not.toBe(mainTip);
    expect(git(repo, 'show', 'main:other.txt')).toBe('someone else merged');
    expect(git(repo, 'show', 'main:impl-native.txt')).toBe('implementation');
    expect(git(repo, 'log', '--merges', 'main')).toBe('');
    const journal = (await server.app.ctx.asyncDb.read((d) => d.select().from(mergeJournal).where(eq(mergeJournal.runId, runId)).all()));
    expect(journal.map((row) => row.kind)).toContain('result');
    expect(journal.map((row) => row.kind)).not.toContain('abandoned'); // it merged, not abandoned
  });

  it('operator Accept still refuses (409) when the base advance conflicts with the candidate, leaving the ticket escalated', async () => {
    const repo = makeRepo();
    await server.app.ctx.workspaces.update(wsId, {
      workingDir: repo,
      verificationCommand: [verificationCommandSchema.parse({ command: process.execPath, args: ['-e', 'process.exit(1)'], timeoutSeconds: 30 })],
    });

    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { 'impl-native.txt': 'implementation\n' } }),
    });
    expect(created.status).toBe(201);
    const taskId: number = created.body.id;
    const started = await server.api('POST', `/api/tasks/${taskId}/run`);
    expect(started.status).toBe(201);
    await waitFor(async () => {
      const t = (await server.api('GET', `/api/tasks/${taskId}`)).body;
      return t.state === 'escalated' ? t : undefined;
    });

    // The base advance touches the SAME file the candidate wrote, so the replay
    // conflicts and there is nothing safe to merge without the operator's help.
    const mainTip = advanceMain(repo, 'impl-native.txt', 'someone else changed this\n');

    const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`);
    expect(accepted.status).toBe(409);
    expect((await server.app.ctx.tasks.get(taskId)).state).toBe('escalated');
    expect(git(repo, 'rev-parse', 'main')).toBe(mainTip); // nothing merged
  });

  it('completion rebase content conflict: N bounded resolve-turns then a plain escalation that links to the diff, never a raw git dump (ADR-0046, #367)', async () => {
    const repo = makeRepo();
    const flag = join(tmpPath('harmonic-conflict-flag-'), 'advanced');
    await server.app.ctx.workspaces.update(wsId, {
      workingDir: repo,
      verificationCommand: [conflictingVerifier(repo, flag)],
      conflictResolveTurns: 2,
      maxAttempts: 6,
    });
    // Turn 0 writes the candidate (which touches conflict.txt); every corrective
    // resolve-turn (self-heal N) just finishes without resolving, so the conflict
    // persists through the whole budget and the Run escalates.
    await server.app.ctx.configStore.update({
      drive: {
        prompt: JSON.stringify({
          turns: [
            { writeFiles: { 'conflict.txt': 'agent version\n', 'impl-{ref}.txt': 'implementation {ref}\n' }, mcpFinish: true },
            { gitExec: [['rebase', '--abort']], mcpFinish: true },
          ],
        }),
      },
    });

    const { taskId, runId } = await launchAfk();
    const escalated = await waitFor(async () => {
      const t = await server.app.ctx.tasks.get(taskId);
      return t.state === 'escalated' ? t : undefined;
    });
    expect(existsSync(flag)).toBe(true); // the verifier really moved main conflictingly

    // Exactly N=2 resolve-turns were dispatched — one per detected conflict, never
    // re-attempted twice on the same poll — then it escalated.
    const events = await lifecycle(runId);
    expect(events.filter((e) => e.event === 'conflict-resolve-turn')).toHaveLength(2);
    expect(events.map((e) => e.event)).toContain('escalated');

    // Plain-language escalation that points at the diff, with NO raw git output:
    // no conflict markers, no `git ...` command echo, no `CONFLICT (content)` dump.
    const reason = escalated.escalationReason ?? '';
    expect(reason).toMatch(/content conflict rebasing/);
    expect(reason).toMatch(/main/);
    expect(reason).toMatch(/diff/);
    expect(reason).not.toMatch(/<<<<<<<|CONFLICT \(content\)|git rebase|rebase .* failed/);
    // Nothing merged: main is still the verifier's own tip, no agent work integrated.
    expect(git(repo, 'show', 'main:conflict.txt')).toBe('main version');
    expect(git(repo, 'log', '--merges', 'main')).toBe('');
  });

  it('completion rebase content conflict resolved within the budget merges the replayed candidate (ADR-0046, #367)', async () => {
    const repo = makeRepo();
    const flag = join(tmpPath('harmonic-conflict-flag-'), 'advanced');
    await server.app.ctx.workspaces.update(wsId, {
      workingDir: repo,
      verificationCommand: [conflictingVerifier(repo, flag)],
      conflictResolveTurns: 2,
      maxAttempts: 6,
    });
    // Turn 0 writes the candidate; the first resolve-turn takes the base's side of
    // conflict.txt and completes the in-progress rebase, so the completion rebase
    // then replays cleanly and the candidate merges.
    await server.app.ctx.configStore.update({
      drive: {
        prompt: JSON.stringify({
          turns: [
            { writeFiles: { 'conflict.txt': 'agent version\n', 'impl-{ref}.txt': 'implementation {ref}\n' }, mcpFinish: true },
            {
              gitExec: [
                ['config', 'core.editor', 'true'],
                ['checkout', '--ours', 'conflict.txt'],
                ['add', 'conflict.txt'],
                ['rebase', '--continue'],
              ],
              mcpFinish: true,
            },
          ],
        }),
      },
    });

    const { taskId, runId } = await launchAfk();
    const task = await waitFor(async () => {
      const t = await server.app.ctx.tasks.get(taskId);
      if (t.state === 'escalated') throw new Error(`escalated instead of merging: ${(await server.app.ctx.runs.get(runId)).reason}`);
      return t.state === 'done' ? t : undefined;
    });
    expect(task.state).toBe('done');

    // One resolve-turn was enough; the replayed candidate merged as a fast-forward.
    const events = await lifecycle(runId);
    expect(events.filter((e) => e.event === 'conflict-resolve-turn')).toHaveLength(1);
    expect(events.map((e) => e.event)).not.toContain('escalated');
    expect(git(repo, 'show', 'main:conflict.txt')).toBe('main version');
    expect(git(repo, 'log', '--merges', 'main')).toBe('');
  });

  // Kept last: it configures a critic on the shared workspace, so running it
  // after the critic-free sibling tests avoids leaking that config into them.
  it('base moved: the deterministic verifier re-runs per rebase but the AI critic reviews the candidate exactly once (ADR-0046)', async () => {
    const repo = makeRepo();
    const flag = join(tmpPath('harmonic-freshness-flag-'), 'advanced');
    criticCalls = 0;
    await server.app.ctx.workspaces.update(wsId, {
      workingDir: repo,
      verificationCommand: [baseMovingVerifier(repo, flag)],
      verificationCritic: verificationCriticSchema.parse({ prompt: 'Review the diff.', model: 'stub-model' }),
    });
    await server.app.ctx.configStore.update({
      drive: { prompt: JSON.stringify({ writeFiles: { 'impl-{ref}.txt': 'implementation {ref}\n' }, mcpFinish: true }) },
    });

    const { taskId, runId } = await launchAfk();
    const task = await waitFor(async () => {
      const t = await server.app.ctx.tasks.get(taskId);
      if (t.state === 'escalated') throw new Error(`escalated instead of merging: ${(await server.app.ctx.runs.get(runId)).reason}`);
      return t.state === 'done' ? t : undefined;
    });
    expect(task.state).toBe('done');
    expect(existsSync(flag)).toBe(true); // the verifier really did move main, forcing a rebase re-entry

    // The deterministic command verifier runs twice (initial + the re-entry at
    // the replayed tree); the critic runs ONCE, on the candidate — never again on
    // the rebase, whose diff it already reviewed.
    const verifications = (await lifecycle(runId)).filter((e) => e.event === 'verification') as Array<{
      event: string;
      mechanism: string;
    }>;
    expect(verifications.filter((e) => e.mechanism === 'command')).toHaveLength(2);
    expect(verifications.filter((e) => e.mechanism === 'critic')).toHaveLength(1);
    expect(criticCalls).toBe(1);
  });
});
