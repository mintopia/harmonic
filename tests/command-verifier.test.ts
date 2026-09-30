import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { VerificationCommand } from '../src/config.js';
import { OperationRegistry, startOperation } from '../src/telemetry/operations.js';
import {
  runCommandVerifier,
  runCommandVerifierDetached,
  commandAttemptToInput,
  exitCodeToVerdict,
  createChildProcessSpawn,
  OUTPUT_CHAR_CAP,
  truncationMarker,
  createOutputPreview,
  type CommandSpawn,
  type CommandSpawnResult,
} from '../src/verification/command-verifier.js';

const providers: NodeTracerProvider[] = [];

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

async function buildCandidate({ workspaceDir }: { workspaceDir: string }): Promise<string> {
  git(workspaceDir, 'add', '-A');
  git(workspaceDir, 'commit', '-m', 'verification fixture');
  return git(workspaceDir, 'rev-parse', 'HEAD');
}

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

function nodeCommand(script: string, over: Partial<VerificationCommand> = {}): VerificationCommand {
  return {
    id: 'cmd-node',
    command: process.execPath,
    args: ['-e', script],
    env: {},
    timeoutSeconds: 30,
    ...over,
  };
}

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
    writeFileSync(join(repo, 'work.txt'), 'candidate work\n');
    const oid = await buildCandidate({ workspaceDir: repo });
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
      cwd: repo,
      verifiedHeadOid: oid,
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
    const parent = startOperation({ type: 'attempt', attributes: { 'attempt.id': 7 } });

    const attempt = await parent.run(() =>
      runCommandVerifier({
        cwd: repo,
        verifiedHeadOid: oid,
        command: nodeCommand('process.exit(1)'),
        spawn: fakeSpawn({ code: 1, signal: null, output: 'nope' }),
        parent: parent.spanContext,
        attributes: { 'task.id': 3, 'attempt.id': 7 },
      }),
    );
    parent.end();

    expect(attempt.verdict).toBe('fail');
    const spans = exporter.getFinishedSpans();
    const run = spans.find((span) => span.name === 'harmonic.attempt');
    const verify = spans.find((span) => span.name === 'harmonic.verify.command');
    if (!run || !verify) throw new Error('Expected exported run and command verification spans');
    expect(verify.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
    expect(verify.attributes).toMatchObject({
      'verification.mechanism': 'command',
      'verification.verdict': 'fail',
      'task.id': 3,
      'attempt.id': 7,
    });
    expect(verify.status.message).toContain('command exited 1');
  });

  it('AC2: non-zero exit → fail', async () => {
    const { repo, oid } = await repoWithCandidate();
    const attempt = await runCommandVerifier({
      cwd: repo,
      verifiedHeadOid: oid,
      command: nodeCommand('process.exit(1)'),
      spawn: fakeSpawn({ code: 1, signal: null, output: '' }),
    });
    expect(attempt.verdict).toBe('fail');
  });

  it('AC2: missing command (ENOENT) → inconclusive, via the real spawner', async () => {
    const { repo, oid } = await repoWithCandidate();
    const attempt = await runCommandVerifier({
      cwd: repo,
      verifiedHeadOid: oid,
      command: {
        id: 'cmd-not-real',
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
      cwd: repo,
      verifiedHeadOid: oid,
      command: nodeCommand('setTimeout(() => {}, 60000)'),
      spawn: createChildProcessSpawn(),
      timeoutMs: 150,
    });
    expect(attempt.verdict).toBe('inconclusive');
    expect(attempt.summary).toMatch(/timed out/);
  });

  it('detached: a bad candidate OID (checkout failure) → inconclusive, never throws', async () => {
    const repo = makeRepo();
    repos.push(repo);
    const attempt = await runCommandVerifierDetached({
      repoDir: repo,
      verifiedHeadOid: '0000000000000000000000000000000000000000',
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
      cwd: repo,
      verifiedHeadOid: oid,
      command: nodeCommand('setTimeout(() => {}, 60000)'),
      spawn: createChildProcessSpawn(),
      signal: ac.signal,
      timeoutMs: 60000,
    });
    expect(attempt.verdict).toBe('inconclusive');
    expect(attempt.summary).toMatch(/cancelled/);
  });

  it('detached: checks out the candidate tree — a command reading a candidate-only file exits 0 (real spawn)', async () => {
    const { repo, oid } = await repoWithCandidate();
    const attempt = await runCommandVerifierDetached({
      repoDir: repo,
      worktreePath: freshWorktreePath(),
      verifiedHeadOid: oid,
      command: nodeCommand('require("node:fs").readFileSync("work.txt"); process.exit(0)'),
      spawn: createChildProcessSpawn(),
    });
    expect(attempt.verdict).toBe('pass');
  });

  it('runs in the given cwd: a command reading a file present in cwd exits 0 (real spawn)', async () => {
    const { repo, oid } = await repoWithCandidate();
    const attempt = await runCommandVerifier({
      cwd: repo,
      verifiedHeadOid: oid,
      command: nodeCommand('require("node:fs").readFileSync("work.txt"); process.exit(0)'),
      spawn: createChildProcessSpawn(),
    });
    expect(attempt.verdict).toBe('pass');
  });

  it('a command that writes to its checkout reports its exit-code verdict', async () => {
    const { repo, oid } = await repoWithCandidate();
    const attempt = await runCommandVerifier({
      cwd: repo,
      verifiedHeadOid: oid,
      command: nodeCommand('require("node:fs").writeFileSync("artifact.txt", "built"); process.exit(0)'),
      spawn: createChildProcessSpawn(),
    });
    expect(attempt.verdict).toBe('pass');
  });

  it('output beyond the cap is truncated (real spawn)', async () => {
    const { repo, oid } = await repoWithCandidate();
    const attempt = await runCommandVerifier({
      cwd: repo,
      verifiedHeadOid: oid,
      // Write well past the cap in chunks and let the process exit naturally, so
      // stdout fully drains to the parent before close (a `process.exit` would
      // truncate the pipe mid-flush and under-fill the buffer).
      command: nodeCommand(`const s="x".repeat(10000); for(let i=0;i<25;i++) process.stdout.write(s);`),
      spawn: createChildProcessSpawn(),
    });
    expect(attempt.output.length).toBeLessThanOrEqual(OUTPUT_CHAR_CAP);
    expect(attempt.output).toContain('truncated');
    expect(attempt.verdict).toBe('pass');
  });

  describe('full output log', () => {
    const script = `process.stdout.write('a'.repeat(1_000_000)); process.stdout.write('TAIL-MARK')`;
    const total = 1_000_009;
    const logDir = (): string => {
      const d = mkdtempSync(join(tmpdir(), 'harmonic-cmdverify-log-'));
      tmpDirs.push(d);
      return d;
    };
    const run = (outputLogPath: string, s = script) =>
      createChildProcessSpawn().run({
        command: nodeCommand(s),
        cwd: tmpdir(),
        timeoutMs: 30_000,
        outputCap: OUTPUT_CHAR_CAP,
        outputLogPath,
      });

    it('writes the full uncapped output to disk', async () => {
      const path = join(logDir(), 'output.log');
      await run(path);
      expect((await stat(path)).size).toBe(total);
      expect((await readFile(path, 'utf8')).endsWith('TAIL-MARK')).toBe(true);
    });

    it('preview keeps head and tail with an exact elided count', async () => {
      const logPath = join(logDir(), 'output.log');
      const r = await run(logPath);
      expect(r.output.length).toBeLessThanOrEqual(OUTPUT_CHAR_CAP);
      expect(r.output.startsWith('aaaa')).toBe(true);
      expect(r.output.endsWith('TAIL-MARK')).toBe(true);
      const m = /\n…\[truncated (\d+) chars; full output: (.+)\]…\n/.exec(r.output);
      expect(m).not.toBeNull();
      const elided = Number(m![1]);
      expect(m![2]).toBe(logPath);
      expect(r.output).toContain(truncationMarker(elided, logPath));
      expect(r.output.length - truncationMarker(elided, logPath).length + elided).toBe(total);
    });

    it('small output equals the file and has no marker', async () => {
      const path = join(logDir(), 'output.log');
      const r = await run(path, `process.stdout.write('hello '); process.stderr.write('world')`);
      expect(r.output).toBe('hello world');
      expect(await readFile(path, 'utf8')).toBe('hello world');
    });

    it('a re-run replaces the previous run output', async () => {
      const path = join(logDir(), 'output.log');
      await run(path, `process.stdout.write('one')`);
      await run(path, `process.stdout.write('two')`);
      expect(await readFile(path, 'utf8')).toBe('two');
    });

    it('an unwritable path does not change the verdict', async () => {
      const bad = join(logDir(), 'missing', 'output.log');
      const { repo, oid } = await repoWithCandidate();
      const attempt = await runCommandVerifier({
        cwd: repo,
        verifiedHeadOid: oid,
        command: nodeCommand(script),
        outputLogPath: bad,
      });
      expect(attempt.verdict).toBe('pass');
      expect(attempt.output.endsWith('TAIL-MARK')).toBe(true);
    });

    it('an unwritable path leaves no file link in the truncation marker', async () => {
      const bad = join(logDir(), 'missing', 'output.log');
      const r = await run(bad);
      expect(r.output).toContain('truncated');
      expect(r.output).not.toContain('full output');
      expect(r.output).not.toContain(bad);
      expect(r.output.length).toBeLessThanOrEqual(OUTPUT_CHAR_CAP);
    });

    it('runCommandVerifier forwards outputLogPath', async () => {
      const path = join(logDir(), 'output.log');
      const { repo, oid } = await repoWithCandidate();
      const attempt = await runCommandVerifier({
        cwd: repo,
        verifiedHeadOid: oid,
        command: nodeCommand(script),
        outputLogPath: path,
      });
      expect(attempt.verdict).toBe('pass');
      expect((await stat(path)).size).toBe(total);
    });
  });

  describe('createOutputPreview', () => {
    it('output equal to the cap has no marker; cap+1 does', () => {
      const a = createOutputPreview(100);
      a.append('x'.repeat(100));
      expect(a.text()).toBe('x'.repeat(100));
      const b = createOutputPreview(100);
      b.append('x'.repeat(50));
      b.append('y'.repeat(51));
      const t = b.text();
      expect(t).toContain('truncated');
      expect(t.length).toBeLessThanOrEqual(100);
    });

    it('keeps head and tail across many small chunks', () => {
      const p = createOutputPreview(200);
      const all = Array.from({ length: 5000 }, (_, i) => String(i % 10)).join('');
      for (const c of all) p.append(c);
      const t = p.text();
      expect(t.length).toBeLessThanOrEqual(200);
      expect(t.startsWith(all.slice(0, 20))).toBe(true);
      expect(t.endsWith(all.slice(-20))).toBe(true);
      const m = /truncated (\d+) chars/.exec(t)!;
      expect(t.length - truncationMarker(Number(m[1])).length + Number(m[1])).toBe(all.length);
    });

    it('never splits a surrogate pair at the head or tail cut', () => {
      for (let cap = 60; cap < 80; cap += 1) {
        const p = createOutputPreview(cap);
        p.append('😀'.repeat(200));
        const t = p.text();
        expect(t.length).toBeLessThanOrEqual(cap);
        expect(Buffer.from(t, 'utf8').toString('utf8')).toBe(t);
        const elided = Number(/truncated (\d+) chars/.exec(t)![1]);
        expect(t.length - truncationMarker(elided).length + elided).toBe(400);
      }
    });
  });
});
