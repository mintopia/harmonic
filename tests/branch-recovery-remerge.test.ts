import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { workspaces, turnQueue } from '../src/db/schema.js';
import { RunFactStore } from '../src/domain/run-facts.js';
import type { MirrorInput } from '../src/domain/tasks.js';

/**
 * Integration proof for issue #155 (reliability-design Unit D): the bounded agent
 * re-merge fallback. When a direct-mode afk Run's git outcome is **ambiguous**
 * and deterministic recovery (#154) cannot safely land, Harmonic asks the agent —
 * in exactly ONE corrective turn via the per-Session turn queue — to re-home its
 * work cleanly, re-entering `validating`. Success is defined as the corrective
 * result matching an allowed commit-set / tree-diff derived from the recorded
 * artifact (the pre-re-merge candidate tree): a match lands; anything else
 * Escalates with **no second mutating turn**.
 */

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

const tmpDirs: string[] = [];

/**
 * A throwaway git repo on branch main with a committed README and a
 * local-markdown tracker declaration, so Harmonic's close-after-land (#139)
 * resolves a real (no-op-close) adapter and the auto-merge Run reaches
 * `completed` rather than escalating on a missing tracker.
 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-remerge-'));
  tmpDirs.push(dir);
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

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('bounded agent re-merge fallback at validating (issue #155)', () => {
  let server: TestServer;
  let ref = 1550; // distinct trackerRef per mirrored Task

  beforeAll(async () => {
    // autoRetry/continueAttempts 0 → the first terminal settle stands. The
    // re-merge lands onto the target branch, so it is auto-merge-only.
    server = await startServer({
      ...stubHarness(),
      drive: { autoRetry: 0, continueAttempts: 0, mergeFate: 'auto-merge' },
    });
  });
  afterAll(async () => {
    await server.close();
  });

  const mirroredAfk = (trackerRef: number, prompt: string): MirrorInput => ({
    trackerRef,
    prompt,
    workflow: 'implement',
    wayfinderType: null,
    drive: 'afk',
    mapRef: null,
    closed: false,
  });

  /** Launch a mirrored afk/direct Run against `repo`. */
  function launchAfkDirect(repo: string, scenario: object): { taskId: number; runId: number } {
    server.app.ctx.db.update(workspaces).set({ workingDir: repo }).run();
    server.app.ctx.configStore.update({ drive: { prompt: JSON.stringify(scenario) } });
    const task = server.app.ctx.tasks.upsertMirrored(mirroredAfk(ref++, 'go'));
    expect(task.drive).toBe('afk');
    expect(task.isolationMode === null || task.isolationMode === 'direct').toBe(true);
    server.app.ctx.tasks.setState(task.id, 'running');
    const run = server.app.ctx.runner.launchClaimed(task.id);
    return { taskId: task.id, runId: run.id };
  }

  const facts = (runId: number) => new RunFactStore(server.app.ctx.db).list(runId);
  const factOfType = (runId: number, type: string) => facts(runId).find((f) => f.type === type);
  const remergeTurns = (runId: number) =>
    server.app.ctx.db.select().from(turnQueue).where(eq(turnQueue.runId, runId)).all();

  const lifecycleEvents = async (runId: number): Promise<Array<{ event: string; [k: string]: unknown }>> =>
    (await server.api('GET', `/api/runs/${runId}/events`)).body.events
      .filter((e: any) => e.type === 'lifecycle')
      .map((e: any) => e.payload);

  const phaseEvents = async (runId: number): Promise<string[]> =>
    (await lifecycleEvents(runId)).filter((p) => p.event === 'phase').map((p) => p.phase as string);

  const settledRun = (runId: number) =>
    waitFor(async () => {
      const r = server.app.ctx.runs.get(runId);
      return r.state !== 'running' ? r : undefined;
    });

  it('lands when the corrective re-merge turn re-homes the same work cleanly (within the allowed set)', async () => {
    const repo = makeRepo();
    const startOid = git(repo, 'rev-parse', 'HEAD');

    // Turn 0 writes real work AND leaves it on a stray branch (an unattributed
    // ref delta → ambiguous). Turn 1 (the bounded re-merge) re-homes the SAME
    // work with no branch mischief — its candidate reproduces the recorded tree,
    // so the allowed-set gate lands it.
    const { taskId, runId } = launchAfkDirect(repo, {
      mcpFinish: true,
      stopReason: 'end_turn',
      turns: [
        { writeFiles: { 'feature.txt': 'the work\n' }, gitExec: [['checkout', '-b', 'stray'], ['commit', '--allow-empty', '-m', 'stray']] },
        {}, // re-merge turn: resume rematerialises the candidate; no mischief → lands
      ],
    });

    const run = await settledRun(runId);
    expect(run.state).toBe('completed');
    expect(server.app.ctx.tasks.get(taskId).escalated).toBe(false);

    // The intended branch advanced to exactly the agent's work.
    expect(git(repo, 'rev-parse', 'main')).not.toBe(startOid);
    expect(git(repo, 'show', 'main:feature.txt')).toBe('the work');

    // A branch-recovery fact records the re-merge land; no branch-violation.
    const recovery = factOfType(runId, 'branch-recovery');
    expect(recovery).toBeDefined();
    expect(JSON.parse(recovery!.payload).via).toBe('re-merge');
    expect(JSON.parse(recovery!.payload).reason).toBe('agent-remerge');
    expect(factOfType(runId, 'branch-violation')).toBeUndefined();

    // Exactly ONE corrective turn, dispatched single-flight on this Session's queue.
    const turns = remergeTurns(runId);
    expect(turns).toHaveLength(1);
    expect(turns[0]!).toMatchObject({ purpose: 're-merge', status: 'done' });
    expect(turns[0]!.sessionId).toBe(`run-${runId}`);

    // The corrective turn re-entered the pipeline at validating (a second
    // executing → validating), never skipping branch validation.
    expect(await phaseEvents(runId)).toEqual(['validating', 'executing', 'validating', 'verifying', 'landing']);
  });

  it('escalates with no second mutating turn when the corrective result is outside the allowed set', async () => {
    const repo = makeRepo();
    const startOid = git(repo, 'rev-parse', 'HEAD');

    // Turn 1 introduces work BEYOND what turn 0 produced (an extra file), so its
    // candidate tree diverges from the recorded artifact → the allowed-set gate
    // rejects it. Exactly one corrective turn is issued, then the Run Escalates.
    const { taskId, runId } = launchAfkDirect(repo, {
      mcpFinish: true,
      stopReason: 'end_turn',
      turns: [
        { writeFiles: { 'feature.txt': 'the work\n' }, gitExec: [['checkout', '-b', 'stray'], ['commit', '--allow-empty', '-m', 'stray']] },
        { writeFiles: { 'extra.txt': 'unexpected new work\n' } }, // tree diverges → reject
      ],
    });

    const run = await settledRun(runId);
    expect(run.state).toBe('failed');
    expect(server.app.ctx.tasks.get(taskId).escalated).toBe(true);

    // Rejected, not landed: the intended branch never moved and no recovery fact
    // was written; the branch-violation fact records the re-merge rejection.
    expect(git(repo, 'rev-parse', 'main')).toBe(startOid);
    expect(factOfType(runId, 'branch-recovery')).toBeUndefined();
    const violation = factOfType(runId, 'branch-violation');
    expect(violation).toBeDefined();
    expect(JSON.parse(violation!.payload).via).toBe('re-merge');
    expect(JSON.parse(violation!.payload).reason).toBe('tree-diverged');
    expect((await lifecycleEvents(runId)).some((e) => e.event === 'branch-remerge-rejected')).toBe(true);

    // Exactly one corrective turn — no second mutating turn (no further re-merge,
    // and no self-heal after a re-merge).
    const turns = remergeTurns(runId);
    expect(turns.filter((t) => t.purpose === 're-merge')).toHaveLength(1);
    expect(turns.filter((t) => t.purpose === 'self-heal')).toHaveLength(0);
  });
});
