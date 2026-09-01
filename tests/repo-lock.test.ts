import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withRepoLock, repoKey } from '../src/execution/repo-lock.js';

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
      expect(order).toEqual(['boom:enter', 'next:enter']);
    });

    it('returns the operation result', async () => {
      await expect(withRepoLock('/repo/x', async () => 42)).resolves.toBe(42);
    });

    it('serialises only the wrapped section — same-repo work outside it still overlaps (AC2)', async () => {
      const repo = '/repo/parallel';
      let execActive = 0;
      let execMax = 0;
      let critActive = 0;
      let critMax = 0;

      const run = () => async () => {
        execActive++;
        execMax = Math.max(execMax, execActive);
        await tick();
        await tick();
        execActive--;
        await withRepoLock(repo, async () => {
          critActive++;
          critMax = Math.max(critMax, critActive);
          await tick();
          critActive--;
        });
      };

      await Promise.all([run()(), run()()]);

      expect(execMax).toBe(2);
      expect(critMax).toBe(1);
    });

    it('is reentrant: a nested acquisition of a held key runs inline instead of deadlocking', async () => {
      const repo = '/repo/reentrant';
      const result = await withRepoLock(repo, async () => {
        const inner = await withRepoLock(repo, async () => 'inner');
        return `outer:${inner}`;
      });
      expect(result).toBe('outer:inner');
    });

    it('reentrancy does not weaken exclusion against a concurrent holder', async () => {
      const repo = '/repo/reentrant-excl';
      let active = 0;
      let maxActive = 0;
      const held = (label: string) =>
        withRepoLock(repo, async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await tick();
          if (label === 'A') {
            await withRepoLock(repo, async () => {
              await tick();
            });
          }
          await tick();
          active--;
        });

      await Promise.all([held('A'), held('B')]);
      expect(maxActive).toBe(1);
    });

    it('a nested acquisition of a DIFFERENT key still serialises normally', async () => {
      const x = '/repo/nest-x';
      const y = '/repo/nest-y';
      let yActive = 0;
      let yMax = 0;
      const op = () =>
        withRepoLock(x, async () => {
          await withRepoLock(y, async () => {
            yActive++;
            yMax = Math.max(yMax, yActive);
            await tick();
            yActive--;
          });
        });
      await Promise.all([op(), op()]);
      expect(yMax).toBe(1);
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
      expect(repoKey(missing + '/')).toBe(missing);
    });
  });
});
