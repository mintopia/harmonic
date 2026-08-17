import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withRepoLock, repoKey } from '../src/execution/repo-lock.js';

/** Resolve on the next macrotask, letting other queued work interleave. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('repo-operation lock (issue #121)', () => {
  describe('withRepoLock', () => {
    it('serialises operations on the same base repo (no interleaving)', async () => {
      const repo = '/repo/a';
      let active = 0;
      let maxActive = 0;
      const trace: string[] = [];

      const op = (id: string) =>
        withRepoLock(repo, async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          trace.push(`${id}:enter`);
          await tick();
          await tick();
          trace.push(`${id}:exit`);
          active--;
        });

      await Promise.all([op('A'), op('B'), op('C')]);

      // Never two critical sections at once, and each op's enter/exit is
      // an uninterrupted pair.
      expect(maxActive).toBe(1);
      expect(trace).toEqual(['A:enter', 'A:exit', 'B:enter', 'B:exit', 'C:enter', 'C:exit']);
    });

    it('runs operations on distinct base repos concurrently', async () => {
      let active = 0;
      let maxActive = 0;

      const op = (repo: string) =>
        withRepoLock(repo, async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await tick();
          active--;
        });

      await Promise.all([op('/repo/a'), op('/repo/b'), op('/repo/c')]);

      // Different keys don't block each other.
      expect(maxActive).toBe(3);
    });

    it('releases the lock when the operation throws, so the next caller proceeds', async () => {
      const repo = '/repo/fail';
      const order: string[] = [];

      const boom = withRepoLock(repo, async () => {
        order.push('boom:enter');
        await tick();
        throw new Error('kaboom');
      });
      const next = withRepoLock(repo, async () => {
        order.push('next:enter');
        return 'ok';
      });

      await expect(boom).rejects.toThrow('kaboom');
      await expect(next).resolves.toBe('ok');
      // The failure did not deadlock the queue.
      expect(order).toEqual(['boom:enter', 'next:enter']);
    });

    it('returns the operation result', async () => {
      await expect(withRepoLock('/repo/x', async () => 42)).resolves.toBe(42);
    });

    it('serialises only the wrapped section — same-repo work outside it still overlaps (AC2)', async () => {
      // Two Runs on the *same* base repo: their execution (the work outside
      // withRepoLock) must run concurrently; only the short mutation window
      // inside withRepoLock serialises. The lock does not serialise execution.
      const repo = '/repo/parallel';
      let execActive = 0;
      let execMax = 0;
      let critActive = 0;
      let critMax = 0;

      const run = () => async () => {
        // Unlocked "execution" phase — overlaps with the other Run.
        execActive++;
        execMax = Math.max(execMax, execActive);
        await tick();
        await tick();
        execActive--;
        // Short locked mutation window — serialised against the other Run.
        await withRepoLock(repo, async () => {
          critActive++;
          critMax = Math.max(critMax, critActive);
          await tick();
          critActive--;
        });
      };

      await Promise.all([run()(), run()()]);

      expect(execMax).toBe(2); // executions ran in parallel on the same repo
      expect(critMax).toBe(1); // mutation windows serialised
    });

    it('a failed op does not corrupt ordering for later ops on the same key', async () => {
      const repo = '/repo/mixed';
      const trace: string[] = [];
      const results = await Promise.allSettled([
        withRepoLock(repo, async () => {
          trace.push('1');
          await tick();
        }),
        withRepoLock(repo, async () => {
          trace.push('2');
          throw new Error('mid-failure');
        }),
        withRepoLock(repo, async () => {
          trace.push('3');
        }),
      ]);

      expect(trace).toEqual(['1', '2', '3']);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    });
  });

  describe('repoKey', () => {
    it('collapses trailing slashes and `.`/`..` segments to one key', () => {
      const base = mkdtempSync(join(tmpdir(), 'repo-key-'));
      const sub = join(base, 'sub');
      mkdirSync(sub);

      expect(repoKey(base)).toBe(repoKey(base + '/'));
      expect(repoKey(base)).toBe(repoKey(join(sub, '..')));
    });

    it('resolves a symlinked path to the same key as its target', () => {
      const base = mkdtempSync(join(tmpdir(), 'repo-key-'));
      const target = join(base, 'target');
      const link = join(base, 'link');
      mkdirSync(target);
      symlinkSync(target, link);

      expect(repoKey(link)).toBe(repoKey(target));
    });

    it('falls back to an absolute path for a non-existent directory', () => {
      const missing = join(tmpdir(), 'repo-key-does-not-exist-xyz');
      expect(repoKey(missing)).toBe(missing);
      // Trailing slash still normalises even without realpath.
      expect(repoKey(missing + '/')).toBe(missing);
    });
  });
});
