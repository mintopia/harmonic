import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VerificationCommand } from '../src/config.js';
import { testSpawnProcessGroup } from './helpers.js';
import {
  exitCodeToVerdict,
  createChildProcessSpawn,
  OUTPUT_CHAR_CAP,
  truncationMarker,
  createOutputPreview,
} from '../src/verification/command-verifier.js';

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

describe('command verifier (issue #135)', () => {
  const tmpDirs: string[] = [];

  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  describe('exitCodeToVerdict table (AC2)', () => {
    it('exit 0 → pass', () => {
      expect(exitCodeToVerdict({ code: 0, signal: null, output: '', stdout: '' })).toEqual({
        verdict: 'pass',
        summary: 'command exited 0',
      });
    });
    it('non-zero exit → fail, naming the code', () => {
      expect(exitCodeToVerdict({ code: 1, signal: null, output: '', stdout: '' })).toMatchObject({ verdict: 'fail' });
      expect(exitCodeToVerdict({ code: 42, signal: null, output: '', stdout: '' })).toEqual({
        verdict: 'fail',
        summary: 'command exited 42',
      });
    });
    it('spawn error → inconclusive', () => {
      expect(
        exitCodeToVerdict({ spawnError: new Error('spawn npm ENOENT'), code: null, signal: null, output: '', stdout: '' }),
      ).toMatchObject({ verdict: 'inconclusive' });
    });
    it('timeout → inconclusive', () => {
      expect(exitCodeToVerdict({ timedOut: true, code: null, signal: 'SIGKILL', output: '', stdout: '' })).toEqual({
        verdict: 'inconclusive',
        summary: 'command timed out',
      });
    });
    it('cancelled → inconclusive', () => {
      expect(exitCodeToVerdict({ aborted: true, code: null, signal: 'SIGKILL', output: '', stdout: '' })).toEqual({
        verdict: 'inconclusive',
        summary: 'command cancelled',
      });
    });
    it('killed by signal with no exit code → inconclusive', () => {
      expect(exitCodeToVerdict({ code: null, signal: 'SIGSEGV', output: '', stdout: '' })).toMatchObject({
        verdict: 'inconclusive',
      });
    });
  });

  describe('real spawn', () => {
    const run = (command: VerificationCommand, over: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
      createChildProcessSpawn(testSpawnProcessGroup).run({ command, cwd: tmpdir(), timeoutMs: over.timeoutMs ?? 30_000, outputCap: OUTPUT_CHAR_CAP, signal: over.signal });

    it('missing command (ENOENT) → inconclusive', async () => {
      const verdict = exitCodeToVerdict(await run({ id: 'cmd-not-real', command: 'definitely-not-a-real-command-xyzzy', args: [], env: {}, timeoutSeconds: 30 }));
      expect(verdict.verdict).toBe('inconclusive');
      expect(verdict.summary).toMatch(/could not be spawned/);
    });

    it('a command that overruns its timeout → inconclusive', async () => {
      const verdict = exitCodeToVerdict(await run(nodeCommand('setTimeout(() => {}, 60000)'), { timeoutMs: 150 }));
      expect(verdict.verdict).toBe('inconclusive');
      expect(verdict.summary).toMatch(/timed out/);
    });

    it('aborting the signal kills the command → inconclusive', async () => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 100);
      const verdict = exitCodeToVerdict(await run(nodeCommand('setTimeout(() => {}, 60000)'), { timeoutMs: 60000, signal: ac.signal }));
      expect(verdict.verdict).toBe('inconclusive');
      expect(verdict.summary).toMatch(/cancelled/);
    });

    it('output beyond the cap is truncated', async () => {
      const r = await run(nodeCommand(`const s="x".repeat(10000); for(let i=0;i<25;i++) process.stdout.write(s);`));
      expect(r.output.length).toBeLessThanOrEqual(OUTPUT_CHAR_CAP);
      expect(r.output).toContain('truncated');
      expect(exitCodeToVerdict(r).verdict).toBe('pass');
    });
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
      createChildProcessSpawn(testSpawnProcessGroup).run({
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
      const m = /\n…\[truncated (\d+) chars\]…\n/.exec(r.output);
      expect(m).not.toBeNull();
      const elided = Number(m![1]);
      expect(r.output).toContain(truncationMarker(elided));
      expect(r.output.length - truncationMarker(elided).length + elided).toBe(total);
      expect(r.output).not.toContain(logPath);
      expect(r.fullOutputSaved).toBe(true);
    });

    it('small output equals the file and has no marker', async () => {
      const path = join(logDir(), 'output.log');
      const r = await run(path, `process.stdout.write('hello '); process.stderr.write('world')`);
      expect(r.output).toBe('hello world');
      expect(r.fullOutputSaved).toBe(false);
      expect(await readFile(path, 'utf8')).toBe('hello world');
    });

    it('a re-run replaces the previous run output', async () => {
      const path = join(logDir(), 'output.log');
      await run(path, `process.stdout.write('one')`);
      await run(path, `process.stdout.write('two')`);
      expect(await readFile(path, 'utf8')).toBe('two');
    });

    it('an unwritable path reports no saved full output', async () => {
      const bad = join(logDir(), 'missing', 'output.log');
      const r = await run(bad);
      expect(r.output).toContain('truncated');
      expect(r.fullOutputSaved).toBe(false);
      expect(r.output.length).toBeLessThanOrEqual(OUTPUT_CHAR_CAP);
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
