import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, seedLocalMarkdownTicket, type TestServer } from './helpers.js';
import { workspaces } from '../src/db/schema.js';
import { RunFactStore } from '../src/domain/run-facts.js';
import { verificationCommandSchema } from '../src/config.js';
import type { MirrorInput } from '../src/domain/tasks.js';

/**
 * Integration proof for issue #154 (reliability-design Unit D): deterministic
 * recovery from recorded OIDs/ref-deltas. An afk/direct Run executes on a
 * detached HEAD (#152), so its verified work lives only on the frozen candidate
 * — the live intended branch never advanced. When the `validating` branch
 * classifier (#150/#151) says the outcome is **recoverable** (the normal
 * detached-HEAD footprint), Harmonic reconstructs that candidate and lands it
 * onto the intended branch (#153) **without an agent turn** — validate → recover
 * → land — then closes the ticket. An **ambiguous** outcome (a stray branch) is
 * NOT deterministically recovered: it escalates via the #151 fallback and the
 * intended branch never moves.
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
const REF_BASE = 1540; // distinct trackerRef base for this file's mirrored Tasks

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-recover-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  mkdirSync(join(dir, 'docs', 'agents'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'agents', 'issue-tracker.md'), '# Issue tracker: local-markdown\n\nPath: tickets\n');
  // Commit an already-`closed` ticket per candidate ref so the close-after-land
  // status write (f705011) is a no-op — the direct-isolation Run then keeps a
  // clean worktree and `main` stays at `startOid` when nothing lands.
  for (let r = REF_BASE; r < REF_BASE + 20; r++) seedLocalMarkdownTicket(dir, r, 'closed');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('deterministic recovery landing at validating (issue #154)', () => {
  let server: TestServer;
  let ref = REF_BASE; // distinct trackerRef per mirrored Task

  beforeAll(async () => {
    // One permitted attempt means the first terminal settle stands, so no
    // second attempt re-runs the funnel mid-assertion. Default mergeFate is
    // auto-merge; state it explicitly since recovery landing is gated on it.
    server = await startServer({
      ...stubHarness(),
      maxAttempts: 1,
      drive: { continueAttempts: 0, mergeFate: 'auto-merge' },
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

  /** Launch a mirrored afk/direct Run against `repo` (mirrors #151/#152's harness). */
  async function launchAfkDirect(repo: string, scenario: object): Promise<{ taskId: number; runId: number }> {
    await server.app.ctx.asyncDb.write((d) => d.update(workspaces).set({ workingDir: repo }).run());
    await server.app.ctx.configStore.update({ drive: { prompt: JSON.stringify(scenario) } });
    const task = await server.app.ctx.tasks.upsertMirrored(mirroredAfk(ref++, 'go'));
    expect(task.drive).toBe('afk');
    expect(task.isolationMode === null || task.isolationMode === 'direct').toBe(true);
    await server.app.ctx.tasks.setState(task.id, 'running');
    const run = await server.app.ctx.runner.launchClaimed(task.id);
    return { taskId: task.id, runId: run.id };
  }

  const facts = (runId: number) => new RunFactStore(server.app.ctx.asyncDb).list(runId);
  const factOfType = async (runId: number, type: string) => (await facts(runId)).find((f) => f.type === type);

  const lifecycleEvents = async (runId: number): Promise<Array<{ event: string; [k: string]: unknown }>> =>
    (await server.api('GET', `/api/runs/${runId}/events`)).body.events
      .filter((e: any) => e.type === 'lifecycle')
      .map((e: any) => e.payload);

  const phaseEvents = async (runId: number): Promise<string[]> =>
    (await lifecycleEvents(runId)).filter((p) => p.event === 'phase').map((p) => p.phase as string);

  it('recovers a clean detached-HEAD Run from recorded commits and lands it, no agent turn', async () => {
    const repo = makeRepo();
    const startOid = git(repo, 'rev-parse', 'HEAD');

    // A verifier that PASSES, so validation → verification passes before landing.
    const wsId = (await server.app.ctx.workspaces.list())[0]!.id;
    await server.app.ctx.workspaces.update(wsId, {
      verificationCommand: verificationCommandSchema.parse({
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        timeoutSeconds: 30,
      }),
    });
    await server.app.ctx.configStore.update({ maxAttempts: 1 });

    // The agent (detached at start by #152) edits a file and finishes — the
    // normal direct-mode footprint: HEAD detached on its own owned ref, a
    // *recoverable* (not ambiguous) contract state.
    const { taskId, runId } = await launchAfkDirect(repo, {
      writeFiles: { 'agent-feature.txt': 'landed by recovery\n' },
      mcpFinish: true,
      stopReason: 'end_turn',
    });

    const run = await waitFor(async () => {
      const r = await server.app.ctx.runs.get(runId);
      return r.state !== 'running' ? r : undefined;
    });

    // The Run completed (verified → recovered → landed → ticket closed).
    expect(run.state).toBe('completed');
    expect((await server.app.ctx.tasks.get(taskId)).escalated).toBe(false);

    // The reconstructed candidate LANDED: the intended branch advanced from the
    // recorded start and now carries the agent's file (its work is on `main`,
    // not merely on a private ref) — the whole point of #154.
    expect(git(repo, 'rev-parse', 'main')).not.toBe(startOid);
    expect(git(repo, 'show', 'main:agent-feature.txt')).toBe('landed by recovery');
    // The live checkout is coherent on the advanced branch.
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(git(repo, 'status', '--porcelain')).toBe('');

    // Structured evidence: a `branch-recovery` fact + `recovery-landed` event,
    // and NO `branch-violation` (this was recoverable, not ambiguous).
    const recovery = await factOfType(runId, 'branch-recovery');
    expect(recovery).toBeDefined();
    expect(JSON.parse(recovery!.payload).reason).toBe('head-detached-on-owned-ref');
    expect((await lifecycleEvents(runId)).some((e) => e.event === 'recovery-landed')).toBe(true);
    expect(await factOfType(runId, 'branch-violation')).toBeUndefined();

    // Deterministic: a single forward pass validating → verifying → landing,
    // with no second executing turn — recovery was git, not an agent re-merge.
    expect(await phaseEvents(runId)).toEqual(['validating', 'verifying', 'landing']);
    expect(run.attempt).toBe(1);
  });

  it('does NOT deterministically recover an ambiguous stray-branch Run (falls through to escalate)', async () => {
    const repo = makeRepo();
    const startOid = git(repo, 'rev-parse', 'HEAD');

    // Under an `open-PR` fate the #155 bounded agent re-merge does not apply
    // (it lands onto the target branch, an `auto-merge`-only path), so an
    // ambiguous outcome falls straight through to the #151 escalate here rather
    // than attempting a corrective turn. The auto-merge re-merge fallback is
    // covered in branch-recovery-remerge.test.ts.
    await server.app.ctx.configStore.update({ drive: { mergeFate: 'open-PR' } });

    // The agent checks out a stray branch and commits — an unattributed ref
    // delta: ambiguous, never auto-recovered.
    const { taskId, runId } = await launchAfkDirect(repo, {
      gitExec: [
        ['checkout', '-b', 'stray'],
        ['commit', '--allow-empty', '-m', 'agent stray work'],
      ],
      mcpFinish: true,
      stopReason: 'end_turn',
    });

    await waitFor(async () => {
      const t = await server.app.ctx.tasks.get(taskId);
      return t.escalated ? t : undefined;
    });

    // Escalated via the #151 fallback, and never deterministically recovered:
    // the intended branch never moved and no recovery fact/event was written.
    expect((await server.app.ctx.tasks.get(taskId)).escalated).toBe(true);
    expect(await factOfType(runId, 'branch-violation')).toBeDefined();
    expect(await factOfType(runId, 'branch-recovery')).toBeUndefined();
    expect((await lifecycleEvents(runId)).some((e) => e.event === 'recovery-landed')).toBe(false);
    expect(git(repo, 'rev-parse', 'main')).toBe(startOid);
  });
});
