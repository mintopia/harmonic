import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_PROBE_ITERATIONS, resolveStatsWorkerEntry } from '../src/db/stats-reader.js';
import { startServer, stubHarness, type TestServer } from './helpers.js';

function spawnStatsWorker(dataDir: string): Worker {
  const { url, execArgv } = resolveStatsWorkerEntry();
  return new Worker(url, { workerData: { dataDir }, ...(execArgv ? { execArgv } : {}) });
}

// Kept a margin below vitest's 20s testTimeout, matching DEFAULT_WAITFOR_TIMEOUT_MS
// in helpers.ts, since worker-thread startup competes for the same CPU as everything
// else under load.
const MESSAGE_TIMEOUT_MS = 15_000;

// Races the expected message against the worker exiting, instead of guessing a fixed
// window in which "no exit" would prove survival — a slow crash outside a short guess
// window used to pass this check and then silently strand the next waitForMessage.
function waitForMessage(worker: Worker, predicate: (message: any) => boolean, timeoutMs = MESSAGE_TIMEOUT_MS): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('waitForMessage: no matching message in time'));
    }, timeoutMs);
    const onMessage = (message: unknown) => {
      if (predicate(message)) {
        cleanup();
        resolve(message);
      }
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`worker exited with code ${code} before a matching message arrived`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('exit', onExit);
    };
    worker.on('message', onMessage);
    worker.on('exit', onExit);
  });
}

describe('stats worker survives bad input (#651)', () => {
  let server: TestServer | undefined;
  let worker: Worker | undefined;

  afterEach(async () => {
    await worker?.terminate();
    worker = undefined;
    await server?.close();
    server = undefined;
  });

  it('responds with an invalid-message error instead of crashing, and keeps processing later requests', async () => {
    server = await startServer(stubHarness());
    worker = spawnStatsWorker(server.dataDir);

    const invalidResponse = waitForMessage(worker, (m) => m?.kind === 'invalid');
    worker.postMessage({ kind: 'read' });
    await expect(invalidResponse).resolves.toMatchObject({ kind: 'invalid', message: expect.any(String) });

    const readResult = waitForMessage(worker, (m) => m?.kind === 'result' && m?.id === 1);
    worker.postMessage({ kind: 'read', id: 1, range: { from: 0, to: Date.now() } });
    await expect(readResult).resolves.toMatchObject({ kind: 'result', id: 1, result: expect.anything() });
  });

  it('rejects an oversized probe from probeHeavyRead itself, and keeps processing later requests', async () => {
    server = await startServer(stubHarness());
    worker = spawnStatsWorker(server.dataDir);

    const errorResponse = waitForMessage(worker, (m) => m?.kind === 'error' && m?.id === 1);
    worker.postMessage({ kind: 'probe', id: 1, iterations: 50_000 });
    await expect(errorResponse).resolves.toMatchObject({
      kind: 'error',
      id: 1,
      message: expect.stringContaining(`1 to ${MAX_PROBE_ITERATIONS}`),
    });

    const readResult = waitForMessage(worker, (m) => m?.kind === 'result' && m?.id === 2);
    worker.postMessage({ kind: 'read', id: 2, range: { from: 0, to: Date.now() } });
    await expect(readResult).resolves.toMatchObject({ kind: 'result', id: 2, result: expect.anything() });
  });
});
