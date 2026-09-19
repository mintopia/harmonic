import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_PROBE_ITERATIONS, resolveStatsWorkerEntry } from '../src/db/stats-reader.js';
import { startServer, stubHarness, type TestServer } from './helpers.js';

function spawnStatsWorker(dataDir: string): Worker {
  const { url, execArgv } = resolveStatsWorkerEntry();
  return new Worker(url, { workerData: { dataDir }, ...(execArgv ? { execArgv } : {}) });
}

function waitForMessage(worker: Worker, predicate: (message: any) => boolean, timeoutMs = 5_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.off('message', onMessage);
      reject(new Error('waitForMessage: no matching message in time'));
    }, timeoutMs);
    const onMessage = (message: unknown) => {
      if (predicate(message)) {
        clearTimeout(timer);
        worker.off('message', onMessage);
        resolve(message);
      }
    };
    worker.on('message', onMessage);
  });
}

function waitForExit(worker: Worker, timeoutMs = 300): Promise<number | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      worker.off('exit', onExit);
      resolve(undefined);
    }, timeoutMs);
    const onExit = (code: number) => {
      clearTimeout(timer);
      resolve(code);
    };
    worker.once('exit', onExit);
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

    const exitCode = await waitForExit(worker);
    expect(exitCode).toBeUndefined();

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

    const exitCode = await waitForExit(worker);
    expect(exitCode).toBeUndefined();

    const readResult = waitForMessage(worker, (m) => m?.kind === 'result' && m?.id === 2);
    worker.postMessage({ kind: 'read', id: 2, range: { from: 0, to: Date.now() } });
    await expect(readResult).resolves.toMatchObject({ kind: 'result', id: 2, result: expect.anything() });
  });
});
