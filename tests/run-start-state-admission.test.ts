import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { workspaces } from '../src/db/schema.js';
import { RunFactStore } from '../src/domain/run-facts.js';
import type { MirrorInput } from '../src/domain/tasks.js';

/**
 * Admission gate for an afk **direct** Run (issue #149, reliability-design
 * Unit D, ADR-0023). `Runner.prepareWorkspace` probes the git start-state
 * before the agent touches anything and, on a clean context, records a
 * `run-start-state` `run_fact`; a context Harmonic cannot safely own (dirty,
 * submodule, nested repo, detached HEAD without a landing branch) is rejected
 * with `AdmissionRejected`, which `driveOnce` routes to `settleEscalated` —
 * Run `failed`, Task `escalate`, an operator-legible reason, and NO
 * `run-start-state` fact.
 *
 * This is the integration proof: a real mirrored **afk / direct** Run is driven
 * through the full server harness (the gate fires only for afk+direct+fresh, so
 * the native `/run` and worktree paths in worktree.test.ts do NOT exercise it).
 * The pure verdict logic has exhaustive unit coverage in run-start-state.
 */

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/** A throwaway git repo on branch main with one committed README. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-149-repo-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

const mirroredAfk = (trackerRef: number): MirrorInput => ({
  trackerRef,
  prompt: `ticket ${trackerRef}`,
  workflow: 'implement',
  wayfinderType: null,
  drive: 'afk',
  mapRef: null,
  closed: false,
});

describe('run-start-state admission gate — afk direct Run (issue #149)', () => {
  let server: TestServer;
  let ref = 900; // distinct trackerRef per mirrored Task (keyed on workspaceId,trackerRef)

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  /**
   * Launch a mirrored **afk / direct** Run against `repo`, exactly as the
   * Auto-Runner's mirrored pick does (issue #32): a mirrored Task inherits its
   * Workspace's workingDir, so point the (single) Workspace at `repo`, flip the
   * Task to running (the lock the pick holds), then `launchClaimed` spawns the
   * Run through the same funnel REST/MCP/Auto-Runner all share.
   */
  function launchAfkDirect(repo: string): { taskId: number; runId: number } {
    server.app.ctx.db.update(workspaces).set({ workingDir: repo }).run();
    const task = server.app.ctx.tasks.upsertMirrored(mirroredAfk(ref++));
    // Sanity: mirrored Tasks resolve to the global `direct` isolation default,
    // so this is genuinely the afk+direct path the gate guards (not worktree).
    expect(task.origin).toBe('mirrored');
    expect(task.drive).toBe('afk');
    expect(task.isolationMode === null || task.isolationMode === 'direct').toBe(true);
    expect(task.workingDir).toBe(repo);
    server.app.ctx.tasks.setState(task.id, 'running');
    const run = server.app.ctx.runner.launchClaimed(task.id);
    return { taskId: task.id, runId: run.id };
  }

  const facts = () => new RunFactStore(server.app.ctx.db);
  const startStateFact = (runId: number) =>
    facts()
      .list(runId)
      .find((f) => f.type === 'run-start-state');

  it('records a run-start-state fact at admission on a clean context, with the real branch, HEAD OID, worktree path, repo root, and a fingerprint', async () => {
    const repo = makeRepo();
    const head = git(repo, 'rev-parse', 'HEAD');
    const toplevel = git(repo, 'rev-parse', '--show-toplevel');

    const { runId } = launchAfkDirect(repo);

    // The fact lands during workspace preparation, before any agent turn.
    const fact = await waitFor(async () => startStateFact(runId));
    const payload = JSON.parse(fact.payload) as {
      startBranch: string;
      startCommit: string;
      worktreePath: string;
      repoIdentity: { root: string; remote: string | null };
      dirtyFingerprint: string;
      landingBranch?: string;
    };

    // The symbolic branch — never the literal `HEAD`.
    expect(payload.startBranch).toBe('main');
    // A 40-hex OID equal to the repo's real HEAD.
    expect(payload.startCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(payload.startCommit).toBe(head);
    // The direct Run's working directory is the repo checkout itself.
    expect(payload.worktreePath).toBe(repo);
    // The canonical repo identity (absolute root).
    expect(payload.repoIdentity.root).toBe(toplevel);
    // A non-empty stable fingerprint of the (clean) working tree.
    expect(typeof payload.dirtyFingerprint).toBe('string');
    expect(payload.dirtyFingerprint.length).toBeGreaterThan(0);
    // On a real branch there is no operator landing branch to record.
    expect(payload.landingBranch).toBeUndefined();
  });

  it('escalates a dirty context (uncommitted changes) instead of running it, recording no run-start-state fact', async () => {
    const repo = makeRepo();
    // An uncommitted (untracked) file makes the working tree dirty.
    writeFileSync(join(repo, 'stray.txt'), 'work Harmonic did not produce\n');

    const { taskId, runId } = launchAfkDirect(repo);

    // The gate rejects → driveOnce settles the Run Escalated (failed).
    const run = await waitFor(async () => {
      const r = server.app.ctx.runs.get(runId);
      return r.state === 'failed' ? r : undefined;
    });
    // Operator-legible reason, prefixed by settleEscalated.
    expect(run.reason ?? '').toMatch(/^escalated to human: /);
    expect((run.reason ?? '').toLowerCase()).toMatch(/uncommitted|dirty|clean context/);

    // The Task is handed back to a human: ready, escalated, drive → hitl.
    const task = server.app.ctx.tasks.get(taskId);
    expect(task.escalated).toBe(true);
    expect(task.drive).toBe('hitl');

    // A rejected context records NO start-state fact.
    expect(startStateFact(runId)).toBeUndefined();
  });

  it('escalates a context containing a nested git repository, recording no run-start-state fact', async () => {
    const repo = makeRepo();
    // An independent repo checked out inside the tree — appears to the outer
    // repo as a single untracked directory whose own `.git` is the tell.
    const nested = join(repo, 'vendor-lib');
    mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init', '-b', 'main', nested], { encoding: 'utf8' });
    writeFileSync(join(nested, 'file.txt'), 'nested\n');

    const { runId } = launchAfkDirect(repo);

    const run = await waitFor(async () => {
      const r = server.app.ctx.runs.get(runId);
      return r.state === 'failed' ? r : undefined;
    });
    expect(run.reason ?? '').toMatch(/^escalated to human: /);
    // The nested-repo check runs before the dirty check, so the specific,
    // more actionable reason surfaces.
    expect((run.reason ?? '').toLowerCase()).toContain('nested git repository');

    expect(startStateFact(runId)).toBeUndefined();
  });
});
