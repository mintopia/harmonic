import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, seedLocalMarkdownTicket, type TestServer } from './helpers.js';
import { verificationCommandSchema } from '../src/config.js';
import type { MirrorInput } from '../src/domain/tasks.js';
import { sessions } from '../src/db/schema.js';

/**
 * Issue #313 — the landing freshness gate (ADR-0041), end to end through the
 * real Runner over the stub harness against a real git Workspace:
 *
 *  - the base advances between verification and landing → landing refuses the
 *    stale verdict, a Rebase Task re-bases the ticket branch, verification
 *    re-runs at the new head, and the land asserts the NEW SHA — all on the
 *    same Attempt and the same Session, no counter increment;
 *  - an operator Accept on a Run whose base moved since verification refuses
 *    (409, feedback on the Run) rather than landing what nobody verified.
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
 * behind verification's back — the exact verify→land window the gate exists
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

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('landing freshness gate (issue #313, ADR-0041)', () => {
  let server: TestServer;
  let wsId: number;
  let ref = 31_300;

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
    drive: 'afk',
    mapRef: null,
    closed: false,
  });

  /** Mirror an afk Task (auto-merge onto main) with its local-markdown ticket
   * committed on main: the ticket file lives in the base repo's checkout, and an
   * in-place land requires that checkout clean. Seeded already `closed` so the
   * post-land close rewrites it byte-identically (the helper's fixed point) and
   * a second Run's land still finds main clean. */
  async function seedAfk(): Promise<{ taskId: number; trackerRef: number }> {
    const trackerRef = ref++;
    const task = await server.app.ctx.tasks.upsertMirrored(mirroredAfk(trackerRef));
    seedLocalMarkdownTicket(task.workingDir, trackerRef, 'closed');
    git(task.workingDir, 'add', '-A');
    git(task.workingDir, 'commit', '-q', '-m', `ticket ${trackerRef}`);
    return { taskId: task.id, trackerRef };
  }

  async function launch(taskId: number): Promise<number> {
    await server.app.ctx.tasks.setState(taskId, 'running');
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

  it('base moved between verify and land: rebase + re-verify on the same Attempt and Session, then land asserting the new SHA', async () => {
    const repo = makeRepo();
    const flag = join(tmpPath('harmonic-freshness-flag-'), 'advanced');
    await server.app.ctx.workspaces.update(wsId, { workingDir: repo, verificationCommand: baseMovingVerifier(repo, flag) });
    await server.app.ctx.configStore.update({
      drive: { prompt: JSON.stringify({ writeFiles: { 'impl-{ref}.txt': 'implementation {ref}\n' }, mcpFinish: true }) },
    });
    const sessionsBefore = (await server.app.ctx.asyncDb.read((d) => d.select().from(sessions).all())).length;

    const { taskId, runId, trackerRef } = await launchAfk();
    const task = await waitFor(async () => {
      const t = await server.app.ctx.tasks.get(taskId);
      if (t.escalated) throw new Error(`escalated instead of landing: ${(await server.app.ctx.runs.get(runId)).reason}`);
      return t.state === 'completed' ? t : undefined;
    });
    expect(task.escalated).toBe(false);
    expect(existsSync(flag)).toBe(true); // the verifier really did move main

    // main = the rebased implementation, fast-forwarded on top of the commit
    // that landed mid-verification — no merge commit.
    expect(git(repo, 'log', '--merges', 'main')).toBe('');
    expect(git(repo, 'log', '--format=%s', '-2', 'main')).toBe(
      ['stub implementation', 'main advances during verification'].join('\n'),
    );
    expect(git(repo, 'show', `main:impl-${trackerRef}.txt`)).toBe(`implementation ${trackerRef}`);
    const run = await server.app.ctx.runs.get(runId);
    expect(run.candidateOid).toBe(git(repo, 'rev-parse', 'main')); // the land asserted the NEW SHA

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
    expect(events.filter((e) => e.event === 'freshness-rebase-required')).toEqual([
      { event: 'freshness-rebase-required', reason: "base 'main' advanced after verification" },
    ]);
    expect(events.filter((e) => e.event === 'verification')).toHaveLength(2);
    expect(events.map((e) => e.event)).not.toContain('escalated');
  });

  it('two afk worktree Runs landing concurrently on one base: the second is refused stale at the land, rebases + re-verifies, then lands its own SHA — no unverified merge commit', async () => {
    const repo = makeRepo();
    await server.app.ctx.workspaces.update(wsId, {
      workingDir: repo,
      verificationCommand: verificationCommandSchema.parse({ command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutSeconds: 30 }),
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
        if (t.escalated) {
          const runs = await server.app.ctx.runs.listForTask(taskId);
          throw new Error(`task ${taskId} escalated instead of landing: ${runs.map((r) => r.reason).join(' | ')}`);
        }
        return t.state === 'completed' ? t : undefined;
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

  it('operator Accept on a stale head refuses (409) and leaves the Run parked with the reason instead of landing', async () => {
    const repo = makeRepo();
    await server.app.ctx.workspaces.update(wsId, { workingDir: repo, verificationCommand: null });

    // A native (human-gated) worktree Run: its prompt IS the stub scenario.
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { 'impl-native.txt': 'implementation\n' } }),
    });
    expect(created.status).toBe(201);
    const taskId: number = created.body.id;
    const started = await server.api('POST', `/api/tasks/${taskId}/run`);
    expect(started.status).toBe(201);
    const runId: number = started.body.id;
    await waitFor(async () => ((await server.app.ctx.tasks.get(taskId)).state === 'awaiting-review' ? true : undefined));
    const verified = (await server.app.ctx.runs.get(runId)).candidateOid;
    expect(verified).toMatch(/^[0-9a-f]{40}$/);

    // The base moves while the Run sits in review.
    const mainTip = advanceMain(repo, 'other.txt', 'someone else landed\n');

    const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`);
    expect(accepted.status).toBe(409);
    expect(JSON.stringify(accepted.body)).toMatch(/advanced after verification/);

    expect((await server.app.ctx.tasks.get(taskId)).state).toBe('awaiting-review');
    const run = await server.app.ctx.runs.get(runId);
    expect(run.reviewFeedback).toMatch(/advanced after verification/);
    expect(git(repo, 'rev-parse', 'main')).toBe(mainTip); // nothing landed
    expect(git(repo, 'log', '--merges', 'main')).toBe('');
  });
});
