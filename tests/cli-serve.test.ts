import { describe, expect, it, vi } from 'vitest';
import { createShutdownHandler } from '../src/cli-serve.js';

describe('createShutdownHandler', () => {
  it('calls release then exit(0), in that order', async () => {
    const calls: string[] = [];
    const release = vi.fn(async () => {
      calls.push('release');
    });
    const exit = vi.fn((code: number) => {
      calls.push(`exit:${code}`);
    });
    const shutdown = createShutdownHandler(release, exit);

    await shutdown();

    expect(calls).toEqual(['release', 'exit:0']);
    expect(release).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('a second sequential invocation calls neither release nor exit again', async () => {
    const release = vi.fn(async () => {});
    const exit = vi.fn();
    const shutdown = createShutdownHandler(release, exit);

    await shutdown();
    await shutdown();

    expect(release).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('concurrent overlapping invocations call neither release nor exit more than once', async () => {
    let resolveRelease: (() => void) | undefined;
    const release = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRelease = resolve;
        }),
    );
    const exit = vi.fn();
    const shutdown = createShutdownHandler(release, exit);

    const first = shutdown();
    const second = shutdown();
    resolveRelease?.();
    await Promise.all([first, second]);

    expect(release).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('a production-shaped release composed of close/telemetry.shutdown/releaseLock runs them in exactly that order', async () => {
    const calls: string[] = [];
    const app = {
      close: vi.fn(async () => {
        calls.push('app.close');
      }),
    };
    const telemetry = {
      shutdown: vi.fn(async () => {
        calls.push('telemetry.shutdown');
      }),
    };
    const releaseLock = vi.fn((dataDir: string) => {
      calls.push(`releaseLock:${dataDir}`);
    });
    const release = async () => {
      await app.close();
      await telemetry.shutdown();
      releaseLock('/data');
    };
    const exit = vi.fn();
    const shutdown = createShutdownHandler(release, exit);

    await shutdown();

    expect(calls).toEqual(['app.close', 'telemetry.shutdown', 'releaseLock:/data']);
  });
});
