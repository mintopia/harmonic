import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { workspaces } from '../src/db/schema.js';
import { RunFactStore } from '../src/domain/run-facts.js';
import { verificationCommandSchema } from '../src/config.js';
import type { MirrorInput } from '../src/domain/tasks.js';

/**
 * Integration proof for issue #151 (reliability-design Unit D): the
 * `validating`-phase branch-contract check. A real afk/direct Run whose agent
 * leaves the git state on a **stray branch** is detected at settle — Harmonic
 * emits a structured `branch-violation` run_fact, Escalates, and **retains** the
 * worktree/refs for operator disposition — while a clean Run passes validation
 * and proceeds to `verifying`. Drives the same funnel as issue #152's isolation
 * integration test (mirrored pick → launchClaimed → direct-mode detach).
 */

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

const tmpDirs: string[] = [];

/** A throwaway git repo on branch main with one committed README. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-bv-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  execFileSync('bash', ['-c', `echo '# repo' > ${join(dir, 'README.md')}`]);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('branch-contract enforcement at validating (issue #151)', () => {
  let server: TestServer;
  let ref = 1510; // distinct trackerRef per mirrored Task

  beforeAll(async () => {
    // One permitted attempt means the first terminal settle stands, so no
    // second attempt re-runs the funnel mid-assertion.
    server = await startServer({
      ...stubHarness(),
      maxAttempts: 1,
      drive: { continueAttempts: 0 },
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
    mapRef: null,
    closed: false,
  });

  /** Launch a mirrored afk/direct Run against `repo`, mirroring the Auto-Runner
   * pick (see issue #152's isolation integration test). */
  async function launchAfkDirect(repo: string, scenario: object): Promise<{ taskId: number; runId: number }> {
    await server.app.ctx.asyncDb.write((d) => d.update(workspaces).set({ workingDir: repo }).run());
    // The stub agent runs the drive prompt as its scenario script; a mirrored
    // Task's own prompt is wrapped under a `## ` header the stub can't parse, so
    // drive.prompt is the reliable seam.
    await server.app.ctx.configStore.update({ drive: { prompt: JSON.stringify(scenario) } });
    const task = await server.app.ctx.tasks.upsertMirrored(mirroredAfk(ref++, 'go'));
    expect(task.isolationMode === null || task.isolationMode === 'direct').toBe(true);
    await server.app.ctx.tasks.setState(task.id, 'working');
    const run = await server.app.ctx.runner.launchClaimed(task.id);
    return { taskId: task.id, runId: run.id };
  }

  const branchViolationFact = async (runId: number) =>
    (await new RunFactStore(server.app.ctx.asyncDb).list(runId)).find((f) => f.type === 'branch-violation');

  const phaseEvents = async (runId: number): Promise<string[]> =>
    (await server.api('GET', `/api/runs/${runId}/events`)).body.events
      .filter((e: any) => e.type === 'lifecycle' && e.payload.event === 'phase')
      .map((e: any) => e.payload.phase);

  it('a stray-branch Run emits a branch-violation fact, Escalates, and retains the refs', async () => {
    const repo = makeRepo();
    const startOid = git(repo, 'rev-parse', 'HEAD');

    // Under an `open-PR` fate the #155 bounded agent re-merge does not apply (it
    // lands onto the target branch, which only an `auto-merge` fate does), so an
    // ambiguous outcome Escalates immediately here — exactly the #151 detection
    // path this test pins. The auto-merge re-merge path is covered separately in
    // branch-recovery-remerge.test.ts.
    await server.app.ctx.configStore.update({ drive: { mergeFate: 'open-PR' } });

    // The agent (detached at start by #152) checks out a stray branch and
    // commits onto it, then signals finish — a branch-contract violation
    // ("Harmonic owns branching") that must be caught in validating.
    const { taskId, runId } = await launchAfkDirect(repo, {
      gitExec: [
        ['checkout', '-b', 'stray'],
        ['commit', '--allow-empty', '-m', 'agent stray work'],
      ],
      mcpFinish: true,
      stopReason: 'end_turn',
    });

    const task = await waitFor(async () => {
      const t = await server.app.ctx.tasks.get(taskId);
      return t.state === 'escalated' ? t : undefined;
    });
    expect(task.state).toBe('escalated');

    // A structured branch-violation run_fact was appended, carrying the verdict
    // and the offending unattributed ref delta.
    const fact = await branchViolationFact(runId);
    expect(fact).toBeDefined();
    const payload = JSON.parse(fact!.payload);
    expect(payload.outcome).toBe('ambiguous');
    expect(payload.reason).toBe('unattributed-ref-delta');
    expect(payload.deltas.map((d: any) => d.ref)).toContain('refs/heads/stray');

    // The Run never advanced to verifying — the violation short-circuited it.
    expect(await phaseEvents(runId)).not.toContain('verifying');

    // Refs/worktree retained for operator disposition: the stray branch still
    // exists, HEAD was NOT restored to main, and the live target never moved.
    expect(git(repo, 'rev-parse', 'refs/heads/stray')).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('stray');
    expect(git(repo, 'rev-parse', 'main')).toBe(startOid);
  });

  it('a clean Run passes validation and proceeds to verifying (no branch-violation fact)', async () => {
    const repo = makeRepo();

    // A failing verifier with self-heal disabled makes the Run settle terminally
    // *at verifying* — reaching verifying at all proves it passed the validating
    // branch check, and the escalation is a verification one, not a branch one.
    const wsId = (await server.app.ctx.workspaces.list())[0]!.id;
    await server.app.ctx.workspaces.update(wsId, {
      verificationCommand: verificationCommandSchema.parse({
        command: process.execPath,
        args: ['-e', 'process.exit(1)'],
        timeoutSeconds: 30,
      }),
    });
    await server.app.ctx.configStore.update({ maxAttempts: 1 });

    // The agent edits a file (no branch/HEAD mischief) and finishes — the normal
    // direct-mode footprint (detached HEAD on its own line), a clean contract.
    const { runId } = await launchAfkDirect(repo, {
      writeFiles: { 'agent-feature.txt': 'clean work\n' },
      mcpFinish: true,
      stopReason: 'end_turn',
    });

    await waitFor(async () => {
      const r = await server.app.ctx.runs.get(runId);
      return r.state !== 'running' ? r : undefined;
    });

    // It reached verifying — validation passed — and no branch-violation fact
    // was ever written.
    expect(await phaseEvents(runId)).toContain('verifying');
    expect(await branchViolationFact(runId)).toBeUndefined();
  });
});
