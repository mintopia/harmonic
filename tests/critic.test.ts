import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCandidate } from '../src/execution/candidate.js';
import {
  runCritic,
  createAcpCriticDrive,
  criticAttemptToInput,
  type CriticHarnessDrive,
  type CriticDriveRequest,
} from '../src/verification/critic.js';
import { defaultConfig, type HarnessConfig } from '../src/config.js';
import { combineVerdicts } from '../web/src/verification-model.js';
import type { VerifierVerdict } from '../web/src/verification-model.js';
import { openDb } from '../src/db/index.js';
import { openAsyncDb } from '../src/db/async.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { VerificationAttemptStore } from '../src/domain/verification-attempts.js';
import { allWorkspaces } from './helpers.js';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/** A throwaway git repo on branch main with one committed README (same
 * template as tests/candidate.test.ts). */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-critic-repo-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

/** Unused by the fake-drive tests, but must satisfy `HarnessConfig`'s shape. */
const FAKE_HARNESS: HarnessConfig = {
  command: 'unused-in-fake-drive-tests',
  args: [],
  env: {},
  models: ['stub-model'],
  defaultModel: 'stub-model',
};

describe('runCritic (issue #136)', () => {
  const tmpDirs: string[] = [];
  const freshWorktreePath = (prefix: string) => {
    const parent = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(parent);
    return join(parent, 'wt');
  };

  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  /** Build a fresh candidate against a throwaway repo, returning both the
   * repo and the candidate OID a test can hand to `runCritic`. */
  async function makeCandidate(ref: string): Promise<{ repo: string; baseOid: string; oid: string }> {
    const repo = makeRepo();
    const baseOid = git(repo, 'rev-parse', 'main');
    writeFileSync(join(repo, 'README.md'), `# repo (changed for ${ref})\n`);
    const oid = await buildCandidate({ repoDir: repo, workspaceDir: repo, baseRev: 'main', ref, message: 'c' });
    return { repo, baseOid, oid };
  }

  it.each([
    ['pass', { verdict: 'pass', summary: 'the change matches the ticket' }],
    ['fail', { verdict: 'fail', summary: 'the change breaks the build' }],
    ['inconclusive', { verdict: 'inconclusive', summary: 'cannot tell from the diff alone' }],
  ] as const)('a fake drive returning a valid %s verdict resolves to a matching CriticAttempt', async (_name, value) => {
    const { repo, baseOid, oid } = await makeCandidate(`refs/harmonic/candidate/run-critic-${value.verdict}`);
    const output = JSON.stringify(value);
    const drive: CriticHarnessDrive = { run: async () => ({ output, permissionRequests: [] }) };

    const attempt = await runCritic({
      repoDir: repo,
      candidateOid: oid,
      baseRev: baseOid,
      worktreePath: freshWorktreePath(`harmonic-critic-wt-${value.verdict}-`),
      critic: { prompt: 'Review the diff.', model: 'stub-model' },
      harness: FAKE_HARNESS,
      harnessId: 'claude',
      drive,
    });

    expect(attempt).toEqual({
      verifier: 'critic',
      verdict: value.verdict,
      summary: value.summary,
      output,
      mutated: false,
      inputOid: oid,
    });
  });

  it('a fake drive returning garbage resolves to inconclusive, never throwing', async () => {
    const { repo, baseOid, oid } = await makeCandidate('refs/harmonic/candidate/run-critic-garbage');
    const drive: CriticHarnessDrive = { run: async () => ({ output: 'not json at all, just prose', permissionRequests: [] }) };

    const attempt = await runCritic({
      repoDir: repo,
      candidateOid: oid,
      baseRev: baseOid,
      worktreePath: freshWorktreePath('harmonic-critic-wt-garbage-'),
      critic: { prompt: 'Review the diff.', model: 'stub-model' },
      harness: FAKE_HARNESS,
      harnessId: 'claude',
      drive,
    });

    expect(attempt.verdict).toBe('inconclusive');
    expect(attempt.summary.length).toBeGreaterThan(0);
    expect(attempt.output).toBe('not json at all, just prose');
    expect(attempt.mutated).toBe(false);
    expect(attempt.inputOid).toBe(oid);
  });

  it('a throwing drive (timeout/death/spawn-fail stand-in) resolves to inconclusive, never throwing', async () => {
    const { repo, baseOid, oid } = await makeCandidate('refs/harmonic/candidate/run-critic-drive-throws');
    const drive: CriticHarnessDrive = {
      run: async () => {
        throw new Error('harness exited before finishing');
      },
    };

    const attempt = await runCritic({
      repoDir: repo,
      candidateOid: oid,
      baseRev: baseOid,
      worktreePath: freshWorktreePath('harmonic-critic-wt-drive-throws-'),
      critic: { prompt: 'Review the diff.', model: 'stub-model' },
      harness: FAKE_HARNESS,
      harnessId: 'claude',
      drive,
    });

    expect(attempt.verdict).toBe('inconclusive');
    expect(attempt.summary).toMatch(/critic drive failed/i);
    expect(attempt.mutated).toBe(false);
  });

  it('read-only: the request the drive receives carries no tracker credentials on the harness config, and the prompt delimits the untrusted diff with the given nonce', async () => {
    const { repo, baseOid, oid } = await makeCandidate('refs/harmonic/candidate/run-critic-readonly');

    let captured: CriticDriveRequest | undefined;
    const drive: CriticHarnessDrive = {
      run: async (req) => {
        captured = req;
        return { output: '{"verdict":"pass","summary":"fine"}', permissionRequests: [] };
      },
    };

    await runCritic({
      repoDir: repo,
      candidateOid: oid,
      baseRev: baseOid,
      worktreePath: freshWorktreePath('harmonic-critic-wt-readonly-'),
      critic: { prompt: 'Review the diff for correctness against the ticket.', model: 'stub-model' },
      harness: FAKE_HARNESS,
      harnessId: 'claude',
      drive,
      nonce: 'fixed-test-nonce',
    });

    expect(captured).toBeDefined();
    // No tracker credential ever rides along on the harness config runCritic
    // hands the drive — unlike a builder Run (Runner.drive), nothing here
    // injects HARMONIC_API_KEY/HARMONIC_MCP_URL into it.
    expect(captured!.harness.env).not.toHaveProperty('HARMONIC_API_KEY');
    expect(captured!.harness.env).not.toHaveProperty('HARMONIC_MCP_URL');
    expect(captured!.prompt).toContain('Review the diff for correctness against the ticket.');
    expect(captured!.prompt).toContain('<<<HARMONIC_UNTRUSTED_DIFF fixed-test-nonce>>>');
    expect(captured!.prompt).toContain('<<<END fixed-test-nonce>>>');
    // The diff between the markers is the real README diff produced above.
    expect(captured!.prompt).toContain('diff --git a/README.md b/README.md');
  });

  it('a drive whose turn mutates the disposable worktree forces the verdict to inconclusive, with mutated:true', async () => {
    const { repo, baseOid, oid } = await makeCandidate('refs/harmonic/candidate/run-critic-mutate');

    const drive: CriticHarnessDrive = {
      run: async (req) => {
        // A misbehaving/compromised critic writing into the checkout it was
        // told to only read — exactly what the fingerprint bracket exists to catch.
        writeFileSync(join(req.cwd, 'critic-side-effect.txt'), 'oops\n');
        return { output: '{"verdict":"pass","summary":"looks great, definitely no problems here"}', permissionRequests: [] };
      },
    };

    const attempt = await runCritic({
      repoDir: repo,
      candidateOid: oid,
      baseRev: baseOid,
      worktreePath: freshWorktreePath('harmonic-critic-wt-mutate-'),
      critic: { prompt: 'Review the diff.', model: 'stub-model' },
      harness: FAKE_HARNESS,
      harnessId: 'claude',
      drive,
    });

    expect(attempt.verdict).toBe('inconclusive');
    expect(attempt.mutated).toBe(true);
  });

  it('a no-op drive does not flip mutated, and the verdict is trusted as reported', async () => {
    const { repo, baseOid, oid } = await makeCandidate('refs/harmonic/candidate/run-critic-noop');
    const drive: CriticHarnessDrive = { run: async () => ({ output: '{"verdict":"pass","summary":"clean"}', permissionRequests: [] }) };

    const attempt = await runCritic({
      repoDir: repo,
      candidateOid: oid,
      baseRev: baseOid,
      worktreePath: freshWorktreePath('harmonic-critic-wt-noop-'),
      critic: { prompt: 'Review the diff.', model: 'stub-model' },
      harness: FAKE_HARNESS,
      harnessId: 'claude',
      drive,
    });

    expect(attempt.mutated).toBe(false);
    expect(attempt.verdict).toBe('pass');
  });

  it('feeds combineVerdicts: pass -> proceed, fail -> block, inconclusive -> escalate', async () => {
    const cases = [
      { verdict: 'pass', output: '{"verdict":"pass","summary":"ok"}', outcome: 'proceed' },
      { verdict: 'fail', output: '{"verdict":"fail","summary":"broken"}', outcome: 'block' },
      { verdict: 'inconclusive', output: '{"verdict":"inconclusive","summary":"unclear"}', outcome: 'escalate' },
    ] as const;

    for (const c of cases) {
      const { repo, baseOid, oid } = await makeCandidate(`refs/harmonic/candidate/run-critic-combine-${c.verdict}`);
      const drive: CriticHarnessDrive = { run: async () => ({ output: c.output, permissionRequests: [] }) };

      const attempt = await runCritic({
        repoDir: repo,
        candidateOid: oid,
        baseRev: baseOid,
        worktreePath: freshWorktreePath(`harmonic-critic-wt-combine-${c.verdict}-`),
        critic: { prompt: 'Review the diff.', model: 'stub-model' },
        harness: FAKE_HARNESS,
        harnessId: 'claude',
        drive,
      });

      const verifierVerdict: VerifierVerdict = { verifier: attempt.verifier, verdict: attempt.verdict };
      expect(combineVerdicts([verifierVerdict])).toEqual({ outcome: c.outcome, reason: expect.any(String) });
    }
  });

  it('AC5 end-to-end: a runCritic attempt persists to the store and the read-back row feeds combineVerdicts', async () => {
    // Proves the two halves of "Attempt persisted; verdict feeds the
    // combination function" join up on a REAL runCritic result, not two
    // isolated fixtures: runCritic -> criticAttemptToInput -> store.append ->
    // list -> map row to a VerifierVerdict -> combineVerdicts. The glue under
    // test is `criticAttemptToInput` mapping `verifier:'critic'` to the store's
    // `mechanism` (the field the integration ticket will persist through).
    const { repo, baseOid, oid } = await makeCandidate('refs/harmonic/candidate/run-critic-persist');
    const drive: CriticHarnessDrive = {
      run: async () => ({ output: '{"verdict":"fail","summary":"the diff drops a null check"}', permissionRequests: [] }),
    };
    const attempt = await runCritic({
      repoDir: repo,
      candidateOid: oid,
      baseRev: baseOid,
      worktreePath: freshWorktreePath('harmonic-critic-wt-persist-'),
      critic: { prompt: 'Review the diff.', model: 'stub-model' },
      harness: FAKE_HARNESS,
      harnessId: 'claude',
      drive,
    });

    const dbDir = mkdtempSync(join(tmpdir(), 'harmonic-critic-persist-db-'));
    tmpDirs.push(dbDir);
    const db = openDb(dbDir);
    // RunStore migrated to the async libsql Db (ADR-0029 #203); this is a
    // one-off local fixture (not the shared beforeEach pattern), so the async
    // connection is opened and closed inline within the test.
    const asyncDb = await openAsyncDb(dbDir);
    const tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
    const runStore = new RunStore(asyncDb);
    const store = new VerificationAttemptStore(db);
    const runId = (await runStore.create(tasks.create({ prompt: 'verify me', state: 'ready' }).id)).id;

    store.append(runId, criticAttemptToInput(attempt));

    const [row, ...rest] = store.list(runId);
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      mechanism: 'critic',
      verdict: 'fail',
      summary: 'the diff drops a null check',
      inputOid: oid,
      phase: 'verifying',
      mutated: false,
    });

    // The persisted row — not the in-memory attempt — feeds the combiner.
    const verifierVerdict: VerifierVerdict = { verifier: row!.mechanism, verdict: row!.verdict as VerifierVerdict['verdict'] };
    expect(combineVerdicts([verifierVerdict])).toEqual({ outcome: 'block', reason: expect.any(String) });

    await asyncDb.close();
  });
});

describe('createAcpCriticDrive (issue #136): the real ACP drive is read-only end to end', () => {
  const STUB_HARNESS = join(import.meta.dirname, 'stub-harness.mjs');
  const tmpDirs: string[] = [];
  const freshCwd = () => {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-critic-drive-cwd-'));
    tmpDirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  // A leaked-looking credential sitting on the operator's own harness config
  // — proves the real drive strips it even if a misconfigured operator env
  // would otherwise carry it into the spawned process, per the module doc's
  // belt-and-braces rationale in `verification/critic.ts`.
  const harness: HarnessConfig = {
    command: process.execPath,
    args: [STUB_HARNESS],
    env: { HARMONIC_API_KEY: 'leaked-key', HARMONIC_MCP_URL: 'http://leaked' },
    models: ['stub-model'],
    defaultModel: 'stub-model',
  };

  it('registers no MCP servers, strips tracker credentials from the spawned env, and denies every permission request', async () => {
    const drive = createAcpCriticDrive();
    const scenario = {
      echoSessionNew: true,
      echoEnv: ['HARMONIC_API_KEY', 'HARMONIC_MCP_URL'],
      requestPermission: { title: 'edit a file', kind: 'edit' },
    };

    const result = await drive.run({
      harness,
      harnessId: 'claude',
      model: 'stub-model',
      cwd: freshCwd(),
      prompt: JSON.stringify(scenario),
      timeoutMs: 15_000,
    });

    // mcpServers:[] reached session/new — no Harmonic MCP tools available.
    expect(result.output).toContain('"mcpServers":[]');
    // The credentials configured on harness.env never reached the child's
    // actual process environment.
    expect(result.output).toContain('"HARMONIC_API_KEY":null');
    expect(result.output).toContain('"HARMONIC_MCP_URL":null');
    // The one permission request the stub made was denied outright.
    expect(result.output).toContain('permission:{"outcome":"cancelled"}');
    expect(result.permissionRequests).toHaveLength(1);
  }, 20_000);

  it('rejects when the harness hangs past the timeout, without leaving the child alive', async () => {
    const drive = createAcpCriticDrive();
    await expect(
      drive.run({
        harness,
        harnessId: 'claude',
        model: 'stub-model',
        cwd: freshCwd(),
        prompt: JSON.stringify({ exit: 'hang' }),
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/timed out/i);
  }, 10_000);
});
