import { describe, expect, it, vi } from 'vitest';
import {
  createShutdownHandler,
  installSystemdUpgrade,
  readSystemdInstalledVersion,
} from '../src/cli-serve.js';

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

describe('systemd upgrades', () => {
  const dataDir = '/var/lib/harmonic';
  const target = '2.6.0';

  it('installs into the service-owned version directory, flips current, and verifies through current', async () => {
    const run = vi.fn(async () => ({}));
    const readFile = vi.fn(() => JSON.stringify({ version: target }));

    await installSystemdUpgrade({ dataDir, target, run });
    const installed = readSystemdInstalledVersion({ dataDir, readFile });

    expect(run).toHaveBeenCalledWith('npm', [
      'i', '--prefix', '/var/lib/harmonic/app/versions/2.6.0', '@mintopia/harmonic@2.6.0',
    ]);
    expect(run).toHaveBeenCalledWith('ln', [
      '-sfn', 'versions/2.6.0', '/var/lib/harmonic/app/current',
    ]);
    expect(readFile).toHaveBeenCalledWith('/var/lib/harmonic/app/current/dist/../package.json', 'utf8');
    expect(installed).toBe(target);
  });

  it('converges when a partially-applied systemd upgrade is retried', async () => {
    const run = vi.fn(async () => ({}));

    await installSystemdUpgrade({ dataDir, target, run });
    await installSystemdUpgrade({ dataDir, target, run });

    expect(run.mock.calls).toEqual([
      ['npm', ['i', '--prefix', '/var/lib/harmonic/app/versions/2.6.0', '@mintopia/harmonic@2.6.0']],
      ['ln', ['-sfn', 'versions/2.6.0', '/var/lib/harmonic/app/current']],
      ['npm', ['i', '--prefix', '/var/lib/harmonic/app/versions/2.6.0', '@mintopia/harmonic@2.6.0']],
      ['ln', ['-sfn', 'versions/2.6.0', '/var/lib/harmonic/app/current']],
    ]);
  });
});
