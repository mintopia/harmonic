import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { buildCandidate } from '../src/execution/candidate.js';
import type { VerificationCommand } from '../src/config.js';
import { OperationRegistry, startOperation } from '../src/telemetry/operations.js';
import {
  runCommandVerifier,
  commandAttemptToInput,
  exitCodeToVerdict,
  createChildProcessSpawn,
  OUTPUT_CHAR_CAP,
  type CommandSpawn,
  type CommandSpawnResult,
} from '../src/verification/command-verifier.js';

const providers: NodeTracerProvider[] = [];

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/** A throwaway git repo on branch main with one committed README. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-cmdverify-repo-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

/** A `VerificationCommand` running an inline node script, all fields explicit. */
function nodeCommand(script: string, over: Partial<VerificationCommand> = {}): VerificationCommand {
  return {
    command: process.execPath,
    args: ['-e', script],
    env: {},
    timeoutSeconds: 30,
    ...over,
  };
}

/** A fake spawner returning a canned result — the injectable seam that lets the
 * checkout / verdict / mutation logic be tested without a real process. */
const fakeSpawn = (result: CommandSpawnResult): CommandSpawn => ({
  async run() {
    return result;
  },
});

describe('command verifier (issue #135)', () => {
  const tmpDirs: string[] = [];
  const repos: string[] = [];
  const freshWorktreePath = (): string => {
    const parent = mkdtempSync(join(tmpdir(), 'harmonic-cmdverify-wt-'));
    tmpDirs.push(parent);
    return join(parent, 'wt');
  };
  const repoWithCandidate = async (): Promise<{ repo: string; oid: string }> => {
    const repo = makeRepo();
    repos.push(repo);
    // A candidate that differs from base, so a verifier has a real tree to run.
    writeFileSync(join(repo, 'work.txt'), 'candidate work\n');
    const oid = await buildCandidate({
      repoDir: repo,
      workspaceDir: repo,
      baseRev: 'main',
      ref: `refs/harmonic/candidate/run-${repos.length}`,
      message: 'candidate',
    });
    return { repo, oid };
  };

  afterAll(() => {
    for (const d of [...tmpDirs, ...repos]) rmSync(d, { recursive: true, force: true });
  });

  afterEach(async () => {
    trace.disable();
    await Promise.all(providers.splice(0).map((provider) => provider.shutdown()));
  });

  describe('exitCodeToVerdict table (AC2)', () => {
    it('exit 0 → pass', () => {
      expect(exitCodeToVerdict({ code: 0, signal: null, output: '' })).toEqual({
        verdict: 'pass',
        summary: 'command exited 0',
      });
    });
    it('non-zero exit → fail, naming the code', () => {
      expect(exitCodeToVerdict({ code: 1, signal: null, output: '' })).toMatchObject({ verdict: 'fail' });
      expect(exitCodeToVerdict({ code: 42, signal: null, output: '' })).toEqual({
        verdict: 'fail',
        summary: 'command exited 42',
      });
    });
    it('spawn error → inconclusive', () => {
      expect(
        exitCodeToVerdict({ spawnError: new Error('spawn npm ENOENT'), code: null, signal: null, output: '' }),
      ).toMatchObject({ verdict: 'inconclusive' });
    });
    it('timeout → inconclusive', () => {
      expect(exitCodeToVerdict({ timedOut: true, code: null, signal: 'SIGKILL', output: '' })).toEqual({
        verdict: 'inconclusive',
        summary: 'command timed out',
      });
    });
    it('cancelled → inconclusive', () => {
      expect(exitCodeToVerdict({ aborted: true, code: null, signal: 'SIGKILL', output: '' })).toEqual({
        verdict: 'inconclusive',
        summary: 'command cancelled',
      });
    });
    it('killed by signal with no exit code → inconclusive', () => {
      expect(exitCodeToVerdict({ code: null, signal: 'SIGSEGV', output: '' })).toMatchObject({
        verdict: 'inconclusive',
      });
    });
  });

  it('AC1/AC3: exit 0 → pass, at the candidate OID, mapped to a persistable attempt', async () => {
    const { repo, oid } = await repoWithCandidate();
    const attempt = await runCommandVerifier({
      repoDir: repo,
      candidateOid: oid,
      worktreePath: freshWorktreePath(),
      command: nodeCommand('process.exit(0)'),
      spawn: fakeSpawn({ code: 0, signal: null, output: 'ok' }),
    });
    expect(attempt.verdict).toBe('pass');
    expect(attempt.verifier).toBe('command');
    expect(attempt.inputOid).toBe(oid);

    const input = commandAttemptToInput(attempt);
    expect(input).toMatchObject({ mechanism: 'command', verdict: 'pass', inputOid: oid, output: 'ok' });
  });

  it('opens a verify.command child operation under the run span when a parent context is supplied', async () => {
    const { repo, oid } = await repoWithCandidate();
    const exporter = new InMemorySpanExporter();
    const registry = new OperationRegistry();
    const provider = new NodeTracerProvider({ spanProcessors: [registry, new SimpleSpanProcessor(exporter)] });
    provider.register();
    providers.push(provider);
    const parent = startOperation({ type: 'run', attributes: { 'run.id': 7 } });

    const attempt = await parent.run(() =>
      runCommandVerifier({
        repoDir: repo,
        candidateOid: oid,
        worktreePath: freshWorktreePath(),
        command: nodeCommand('process.exit(1)'),
        spawn: fakeSpawn({ code: 1, signal: null, output: 'nope' }),
        parent: parent.spanContext,
        attributes: { 'task.id': 3, 'run.id': 7 },
      }),
    );
    parent.end();

    expect(attempt.verdict).toBe('fail');
    const spans = exporter.getFinishedSpans();
    const run = spans.find((span) => span.name === 'harmonic.run');
    const verify = spans.find((span) => span.name === 'harmonic.verify.command');
    if (!run || !verify) throw new Error('Expected exported run and command verification spans');
    expect(verify.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
    expect(verify.attributes).toMatchObject({
      'verification.mechanism': 'command',
      'verification.verdict': 'fail',
      'task.id': 3,
      'run.id': 7,
    });
    expect(verify.status.message).toContain('command exited 1');
  });

  it('AC2: non-zero exit → fail', async () => {
    const { repo, oid } = await repoWithCandidate();
    const attempt = await runCommandVerifier({
      repoDir: repo,
      candidateOid: oid,
      worktreePath: freshWorktreePath(),
      command: nodeCommand('process.exit(1)'),
      spawn: fakeSpawn({ code: 1, signal: null, output: '' }),
    });
    expect(attempt.verdict).toBe('fail');
  });

  it('AC2: missing command (ENOENT) → inconclusive, via the real spawner', async () => {
    const { repo, oid } = await repoWithCandidate();
    const attempt = await runCommandVerifier({
      repoDir: repo,
      candidateOid: oid,
      worktreePath: freshWorktreePath(),
      command: {
        command: 'definitely-not-a-real-command-xyzzy',
        args: [],
        env: {},
        timeoutSeconds: 30,
      },
      spawn: createChildProcessSpawn(),
    });
    expect(attempt.verdict).toBe('inconclusive');
    expect(attempt.summary).toMatch(/could not be spawned/);
  });

  it('AC2: a command that overruns its timeout → inconclusive (real spawn)', async () => {
    const { repo, oid } = await repoWithCandidate();
    const attempt = await runCommandVerifier({
      repoDir: repo,
      candidateOid: oid,
      worktreePath: freshWorktreePath(),
      // Sleeps well past the timeout; the spawner SIGKILLs it.
      command: nodeCommand('setTimeout(() => {}, 60000)'),
      spawn: createChildProcessSpawn(),
      timeoutMs: 150,
    });
    expect(attempt.verdict).toBe('inconclusive');
    expect(attempt.summary).toMatch(/timed out/);
  });

  it('AC2: a bad candidate OID (checkout failure) → inconclusive, never throws', async () => {
    const repo = makeRepo();
    repos.push(repo);
    const attempt = await runCommandVerifier({
      repoDir: repo,
      candidateOid: '0000000000000000000000000000000000000000',
      worktreePath: freshWorktreePath(),
      command: nodeCommand('process.exit(0)'),
    });
    expect(attempt.verdict).toBe('inconclusive');
    expect(attempt.summary).toMatch(/could not check out the candidate/);
  });

  it('cancellation: aborting the signal kills the command → inconclusive (real spawn)', async () => {
    const { repo, oid } = await repoWithCandidate();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const attempt = await runCommandVerifier({
      repoDir: repo,
      candidateOid: oid,
      worktreePath: freshWorktreePath(),
      command: nodeCommand('setTimeout(() => {}, 60000)'),
      spawn: createChildProcessSpawn(),
      signal: ac.signal,
      timeoutMs: 60000,
    });
    expect(attempt.verdict).toBe('inconclusive');
    expect(attempt.summary).toMatch(/cancelled/);
  });

  it('runs at the candidate tree: a command reading a candidate-only file exits 0 (real spawn)', async () => {
    const { repo, oid } = await repoWithCandidate();
    const attempt = await runCommandVerifier({
      repoDir: repo,
      candidateOid: oid,
      worktreePath: freshWorktreePath(),
      // work.txt exists only in the candidate, not the base commit — a pass here
      // proves the command ran against the frozen candidate checkout.
      command: nodeCommand('require("node:fs").readFileSync("work.txt"); process.exit(0)'),
      spawn: createChildProcessSpawn(),
    });
    expect(attempt.verdict).toBe('pass');
  });

  it('a command that mutates its checkout still reports its exit-code verdict (not overridden)', async () => {
    const { repo, oid } = await repoWithCandidate();
    const attempt = await runCommandVerifier({
      repoDir: repo,
      candidateOid: oid,
      worktreePath: freshWorktreePath(),
      // Writes a file (mutating the disposable checkout) then exits 0.
      command: nodeCommand('require("node:fs").writeFileSync("artifact.txt", "built"); process.exit(0)'),
      spawn: createChildProcessSpawn(),
    });
    expect(attempt.mutated).toBe(true);
    // Unlike the critic, a command's verdict is NOT overridden by mutation.
    expect(attempt.verdict).toBe('pass');
  });

  it('output beyond the cap is truncated (real spawn)', async () => {
    const { repo, oid } = await repoWithCandidate();
    const attempt = await runCommandVerifier({
      repoDir: repo,
      candidateOid: oid,
      worktreePath: freshWorktreePath(),
      // Write well past the cap in chunks and let the process exit naturally, so
      // stdout fully drains to the parent before close (a `process.exit` would
      // truncate the pipe mid-flush and under-fill the buffer).
      command: nodeCommand(`const s="x".repeat(10000); for(let i=0;i<25;i++) process.stdout.write(s);`),
      spawn: createChildProcessSpawn(),
    });
    expect(attempt.output.length).toBe(OUTPUT_CHAR_CAP);
    expect(attempt.verdict).toBe('pass');
  });
});
