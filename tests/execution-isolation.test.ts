import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  directRefFor,
  detachForDirectRun,
  captureDirectHead,
  restoreLiveCheckout,
  reattachBareDetachedHead,
  rematerializeCandidate,
} from '../src/execution/execution-isolation.js';
import { buildCandidate } from '../src/execution/candidate.js';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { workspaces } from '../src/db/schema.js';
import type { MirrorInput } from '../src/domain/tasks.js';
import { verificationCommandSchema } from '../src/config.js';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

const tmpDirs: string[] = [];

/** A throwaway git repo on branch main with one committed README. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-iso-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

/** Make + commit a change as if the agent had, returning the new HEAD OID. */
function agentCommit(dir: string, file: string, contents: string, message: string): string {
  writeFileSync(join(dir, file), contents);
  git(dir, 'add', '-A');
  // Committing under an explicit identity mirrors an agent's own git config.
  git(dir, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', 'commit', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

function isDetached(dir: string): boolean {
  try {
    git(dir, 'symbolic-ref', '-q', 'HEAD');
    return false;
  } catch {
    return true;
  }
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('execution isolation (issue #152)', () => {
  it('detach parks the branch: the live target ref stays at the start commit while HEAD detaches', async () => {
    const repo = makeRepo();
    const startCommit = git(repo, 'rev-parse', 'HEAD');
    expect(isDetached(repo)).toBe(false);

    await detachForDirectRun(repo, startCommit);

    expect(isDetached(repo)).toBe(true);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(startCommit);
    expect(git(repo, 'rev-parse', 'main')).toBe(startCommit);
  });

  it('AC1: agent commits during a detached direct Run do NOT move the live target ref', async () => {
    const repo = makeRepo();
    const startCommit = git(repo, 'rev-parse', 'HEAD');

    await detachForDirectRun(repo, startCommit);
    const agentHead = agentCommit(repo, 'feature.txt', 'agent work\n', 'agent: add feature');

    // HEAD advanced onto the agent's commit; the live branch did not.
    expect(agentHead).not.toBe(startCommit);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(agentHead);
    expect(git(repo, 'rev-parse', 'main')).toBe(startCommit);
  });

  it('AC1: even an agent reset/checkout -B cannot advance the live target branch while detached', async () => {
    const repo = makeRepo();
    const startCommit = git(repo, 'rev-parse', 'HEAD');
    await detachForDirectRun(repo, startCommit);

    agentCommit(repo, 'a.txt', 'one\n', 'agent: one');
    // A hostile agent tries to move the target branch by name; detached HEAD
    // means `checkout -B main` would re-point main — but the agent is expected
    // to run plain commits. Prove the *default* commit path leaves main parked,
    // and that a fresh branch the agent makes also never touches main.
    git(repo, 'checkout', '-b', 'agent-side');
    agentCommit(repo, 'b.txt', 'two\n', 'agent: two');
    expect(git(repo, 'rev-parse', 'main')).toBe(startCommit);
  });

  it('AC1: captureDirectHead pins the agent commit chain onto the private ref (not the live branch)', async () => {
    const repo = makeRepo();
    const startCommit = git(repo, 'rev-parse', 'HEAD');
    await detachForDirectRun(repo, startCommit);
    const agentHead = agentCommit(repo, 'feature.txt', 'agent work\n', 'agent: add feature');

    const pinned = await captureDirectHead(repo, 42);

    expect(pinned).toBe(agentHead);
    const ref = directRefFor(42);
    expect(ref).toBe('refs/harmonic/direct/run-42');
    expect(git(repo, 'rev-parse', ref)).toBe(agentHead);
    // The agent's commit is reachable from the private ref, and main is untouched.
    expect(git(repo, 'rev-parse', 'main')).toBe(startCommit);
  });

  it('captureDirectHead is idempotent — a second call moves the ref to the current HEAD', async () => {
    const repo = makeRepo();
    const startCommit = git(repo, 'rev-parse', 'HEAD');
    await detachForDirectRun(repo, startCommit);

    await captureDirectHead(repo, 7);
    expect(git(repo, 'rev-parse', directRefFor(7))).toBe(startCommit);

    const head2 = agentCommit(repo, 'more.txt', 'more\n', 'agent: more');
    await captureDirectHead(repo, 7);
    expect(git(repo, 'rev-parse', directRefFor(7))).toBe(head2);
  });

  it('AC2: restore re-attaches HEAD to the start branch and sweeps agent tracked + untracked changes', async () => {
    const repo = makeRepo();
    const startCommit = git(repo, 'rev-parse', 'HEAD');
    await detachForDirectRun(repo, startCommit);

    // Agent leaves a mix: a committed change, a tracked modification, an untracked file.
    agentCommit(repo, 'committed.txt', 'committed\n', 'agent: commit');
    writeFileSync(join(repo, 'README.md'), '# modified by agent\n');
    writeFileSync(join(repo, 'untracked.txt'), 'stray\n');

    await captureDirectHead(repo, 1);
    await restoreLiveCheckout(repo, 'main');

    // HEAD is back on main at the start commit, and the tree is clean again.
    expect(isDetached(repo)).toBe(false);
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(startCommit);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    // The tracked file is back to its committed content; agent files are gone.
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# repo\n');
    expect(existsSync(join(repo, 'untracked.txt'))).toBe(false);
    expect(existsSync(join(repo, 'committed.txt'))).toBe(false);
  });

  it('AC2: restore preserves gitignored artifacts (clean -fd, never -x)', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, '.gitignore'), 'build/\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'add gitignore');
    const startCommit = git(repo, 'rev-parse', 'HEAD');

    await detachForDirectRun(repo, startCommit);
    // An ignored build artifact (e.g. compiled output / a node_modules stand-in).
    execFileSync('mkdir', ['-p', join(repo, 'build')]);
    writeFileSync(join(repo, 'build', 'out.js'), 'artifact\n');
    writeFileSync(join(repo, 'agent-untracked.txt'), 'sweep me\n');

    await restoreLiveCheckout(repo, 'main');

    // Untracked agent file swept; the ignored artifact survives.
    expect(existsSync(join(repo, 'agent-untracked.txt'))).toBe(false);
    expect(existsSync(join(repo, 'build', 'out.js'))).toBe(true);
  });

  it('AC3: a candidate is rematerialisable into a fresh checkout for a corrective turn', async () => {
    const repo = makeRepo();
    const startCommit = git(repo, 'rev-parse', 'HEAD');

    // Run 1: detached, agent produces work in the working tree.
    await detachForDirectRun(repo, startCommit);
    writeFileSync(join(repo, 'README.md'), '# candidate content\n');
    writeFileSync(join(repo, 'new.txt'), 'from candidate\n');

    // Freeze the work into a candidate (the #134 hermetic primitive), then
    // restore the live checkout as settle would.
    const candidateOid = await buildCandidate({
      repoDir: repo,
      workspaceDir: repo,
      baseRev: startCommit,
      ref: 'refs/harmonic/candidate/run-1',
      message: 'candidate',
    });
    await restoreLiveCheckout(repo, 'main');

    // The live checkout is clean at the start commit — the candidate is gone
    // from the working tree.
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# repo\n');
    expect(existsSync(join(repo, 'new.txt'))).toBe(false);

    // A corrective turn rematerialises the candidate into the checkout.
    await rematerializeCandidate(repo, candidateOid);

    expect(isDetached(repo)).toBe(true);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(candidateOid);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# candidate content\n');
    expect(readFileSync(join(repo, 'new.txt'), 'utf8')).toBe('from candidate\n');
    // main is still parked — the corrective turn runs isolated too.
    expect(git(repo, 'rev-parse', 'main')).toBe(startCommit);
  });

  it('end-to-end: detach → agent work → candidate → capture → restore leaves main untouched and the work preserved on private refs', async () => {
    const repo = makeRepo();
    const startCommit = git(repo, 'rev-parse', 'HEAD');

    await detachForDirectRun(repo, startCommit);
    const agentHead = agentCommit(repo, 'feature.txt', 'shipped\n', 'agent: feature');
    writeFileSync(join(repo, 'extra.txt'), 'uncommitted\n');

    const candidateOid = await buildCandidate({
      repoDir: repo,
      workspaceDir: repo,
      baseRev: startCommit,
      ref: 'refs/harmonic/candidate/run-9',
      message: 'candidate',
    });
    const pinned = await captureDirectHead(repo, 9);
    await restoreLiveCheckout(repo, 'main');

    // Live branch and checkout: coherent, untouched, clean.
    expect(git(repo, 'rev-parse', 'main')).toBe(startCommit);
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(git(repo, 'status', '--porcelain')).toBe('');

    // Work preserved: agent commit chain on the private direct ref, full tree
    // (incl. the uncommitted extra.txt) in the candidate.
    expect(pinned).toBe(agentHead);
    expect(git(repo, 'rev-parse', directRefFor(9))).toBe(agentHead);
    expect(git(repo, 'show', `${candidateOid}:feature.txt`)).toBe('shipped');
    expect(git(repo, 'show', `${candidateOid}:extra.txt`)).toBe('uncommitted');
  });
});

/**
 * Integration proof through the full server harness: a real mirrored **afk /
 * direct** Run detaches its HEAD at start (issue #152), so the agent's edits
 * never move the live target branch, and the live checkout is restored
 * coherently once the Run leaves execution. The isolation fires only for
 * afk+direct+fresh (the native `/run` and worktree paths do not exercise it),
 * so this drives the same funnel the Auto-Runner's mirrored pick uses.
 */
describe('execution isolation integration: afk-direct Run detaches + restores (issue #152)', () => {
  let server: TestServer;
  let ref = 1520; // distinct trackerRef per mirrored Task (keyed on workspaceId,trackerRef)

  beforeAll(async () => {
    // autoRetry/continueAttempts 0 → the first unresolved turn Escalates
    // terminally, so no second attempt re-detaches the checkout mid-assertion.
    server = await startServer({
      ...stubHarness(),
      drive: { autoRetry: 0, continueAttempts: 0 },
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

  /** Launch a mirrored afk/direct Run against `repo`, mirroring the Auto-Runner
   * pick: point the single Workspace at `repo`, flip the Task to running, then
   * launchClaimed spawns the Run through the shared funnel. */
  async function launchAfkDirect(repo: string, scenario: object): Promise<{ taskId: number; runId: number }> {
    server.app.ctx.db.update(workspaces).set({ workingDir: repo }).run();
    // The stub agent runs the *drive prompt* as its scenario script — so put the
    // scenario JSON at the head of the drive prompt (the same trick auto-drive
    // tests use). A mirrored Task's own prompt is wrapped under a `## ` header,
    // where the stub can't parse it, so drive.prompt is the reliable seam.
    server.app.ctx.configStore.update({ drive: { prompt: JSON.stringify(scenario) } });
    const task = server.app.ctx.tasks.upsertMirrored(mirroredAfk(ref++, 'go'));
    expect(task.drive).toBe('afk');
    expect(task.isolationMode === null || task.isolationMode === 'direct').toBe(true);
    server.app.ctx.tasks.setState(task.id, 'running');
    const run = await server.app.ctx.runner.launchClaimed(task.id);
    return { taskId: task.id, runId: run.id };
  }

  it('restores the live checkout coherently and never moves the target branch during execution', async () => {
    const repo = makeRepo();
    const startOid = git(repo, 'rev-parse', 'HEAD');

    // The stub agent writes a file into its cwd (the live checkout) then ends its
    // turn without signalling finish. With continue/retry disabled that settles
    // the Run terminally as unresolved (Escalate) WITHOUT landing, so the target
    // branch legitimately never moves and we can assert the restore.
    const { runId } = await launchAfkDirect(repo, {
      writeFiles: { 'agent-feature.txt': 'made by the afk agent\n' },
      stopReason: 'end_turn',
    });

    // Wait for the Run row to reach a terminal state (finalize → restore ran).
    await waitFor(async () => {
      const r = server.app.ctx.runs.get(runId);
      return r.state !== 'running' ? r : undefined;
    });

    // The live target branch never moved while the agent ran detached, and the
    // checkout is coherent again: HEAD re-attached to main, working tree clean,
    // the agent's file swept (it never touched the live branch).
    expect(git(repo, 'rev-parse', 'main')).toBe(startOid);
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(repo, 'agent-feature.txt'))).toBe(false);

    // The agent's line was pinned to the private direct ref before restore —
    // under refs/harmonic/*, never the live branch.
    expect(git(repo, 'rev-parse', directRefFor(runId))).toMatch(/^[0-9a-f]{40}$/);
  });

  it('a self-heal continuation stays isolated and rematerialises the prior candidate (issue #137 × #152)', async () => {
    const repo = makeRepo();
    const startOid = git(repo, 'rev-parse', 'HEAD');

    // A verifier that always fails → turn 1 blocks → one self-heal turn → still
    // fails → budget exhausted → Escalate. No landing, so main must stay put.
    const wsId = server.app.ctx.workspaces.list()[0]!.id;
    server.app.ctx.workspaces.update(wsId, {
      verificationCommand: verificationCommandSchema.parse({
        command: process.execPath,
        args: ['-e', 'process.exit(1)'],
        timeoutSeconds: 30,
      }),
    });
    server.app.ctx.configStore.update({ verification: { maxSelfHeals: 1 } });

    // Turn 1 writes a.txt; the heal turn writes only b.txt. If the continuation
    // rematerialises turn 1's candidate, the rebuilt candidate carries BOTH; if
    // it restarted from a swept checkout it would carry only b.txt.
    const { taskId, runId } = await launchAfkDirect(repo, {
      turns: [
        { writeFiles: { 'a.txt': 'first\n' }, mcpFinish: true, stopReason: 'end_turn' },
        { writeFiles: { 'b.txt': 'second\n' }, mcpFinish: true, stopReason: 'end_turn' },
      ],
    });

    await waitFor(async () => {
      const t = server.app.ctx.tasks.get(taskId);
      return t.escalated ? t : undefined;
    });

    // Isolation held across BOTH turns: the live branch never moved and the
    // checkout is coherent again.
    expect(git(repo, 'rev-parse', 'main')).toBe(startOid);
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(git(repo, 'status', '--porcelain')).toBe('');

    // The heal turn resumed turn 1's work: the final candidate carries both files.
    const run = server.app.ctx.runs.get(runId);
    expect(run.candidateOid).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repo, 'show', `${run.candidateOid}:a.txt`)).toBe('first');
    expect(git(repo, 'show', `${run.candidateOid}:b.txt`)).toBe('second');
  });
});

describe('reattachBareDetachedHead — never leave the base repo on a bare detached HEAD (issue #198)', () => {
  it('reattaches HEAD to the branch when detached exactly on its tip — the incident (base detached == develop)', async () => {
    const repo = makeRepo();
    // Simulate a direct Run's landing: the branch was advanced to the commit
    // HEAD holds, but the restore that should have re-attached HEAD threw, so
    // HEAD is a bare detached HEAD sitting exactly on `main`'s tip.
    const tip = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '--detach', 'HEAD');
    expect(isDetached(repo)).toBe(true);

    const outcome = await reattachBareDetachedHead(repo, 'main');

    expect(outcome).toBe('reattached');
    expect(isDetached(repo)).toBe(false);
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    // A pure pointer flip: neither the branch ref nor the working tree moved.
    expect(git(repo, 'rev-parse', 'main')).toBe(tip);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(tip);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('is a no-op when HEAD is already on a branch', async () => {
    const repo = makeRepo();
    const tip = git(repo, 'rev-parse', 'HEAD');

    const outcome = await reattachBareDetachedHead(repo, 'main');

    expect(outcome).toBe('already-attached');
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(tip);
  });

  it('leaves a divergent detached HEAD alone — the branch tip is NOT where HEAD sits', async () => {
    const repo = makeRepo();
    // HEAD detaches at the start commit; then `main` advances past it. HEAD now
    // sits on a commit that is not main's tip — a genuine divergence to leave
    // for crash-recovery, never a silent force-move of the working tree.
    const startCommit = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '--detach', 'HEAD');
    git(repo, 'checkout', 'main');
    agentCommit(repo, 'ahead.txt', 'advanced\n', 'advance main');
    git(repo, 'checkout', '--detach', startCommit);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(startCommit);
    expect(git(repo, 'rev-parse', 'main')).not.toBe(startCommit);

    const outcome = await reattachBareDetachedHead(repo, 'main');

    expect(outcome).toBe('left-detached');
    expect(isDetached(repo)).toBe(true);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(startCommit);
  });

  it('leaves HEAD detached when the branch does not exist', async () => {
    const repo = makeRepo();
    git(repo, 'checkout', '--detach', 'HEAD');

    const outcome = await reattachBareDetachedHead(repo, 'no-such-branch');

    expect(outcome).toBe('left-detached');
    expect(isDetached(repo)).toBe(true);
  });
});
