import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveTelemetryOptions } from '../src/telemetry.js';
import { stopDaemon, writeDaemon } from '../src/daemon.js';

const telemetryUrl = pathToFileURL(new URL('../src/telemetry.ts', import.meta.url).pathname).href;
const loggerUrl = pathToFileURL(new URL('../src/logger.ts', import.meta.url).pathname).href;
const operationsUrl = pathToFileURL(new URL('../src/telemetry/operations.ts', import.meta.url).pathname).href;
const apiUrl = pathToFileURL(new URL('../node_modules/@opentelemetry/api/build/src/index.js', import.meta.url).pathname).href;

const savedEnv = {
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  headers: process.env.OTEL_EXPORTER_OTLP_HEADERS,
  enabled: process.env.OTEL_EXPORTER_OTLP_ENABLED,
  logLevel: process.env.OTEL_STDOUT_LOG_LEVEL,
  metricExportInterval: process.env.OTEL_METRIC_EXPORT_INTERVAL,
};

afterEach(() => {
  for (const [name, value] of Object.entries({
    OTEL_EXPORTER_OTLP_ENDPOINT: savedEnv.endpoint,
    OTEL_EXPORTER_OTLP_HEADERS: savedEnv.headers,
    OTEL_EXPORTER_OTLP_ENABLED: savedEnv.enabled,
    OTEL_STDOUT_LOG_LEVEL: savedEnv.logLevel,
    OTEL_METRIC_EXPORT_INTERVAL: savedEnv.metricExportInterval,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('telemetry configuration', () => {
  it('uses OTEL environment values and lets CLI values win', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://env.test:4318';
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'authorization=env-token';
    process.env.OTEL_EXPORTER_OTLP_ENABLED = 'false';
    process.env.OTEL_STDOUT_LOG_LEVEL = 'warn';
    process.env.OTEL_METRIC_EXPORT_INTERVAL = '2500';

    expect(resolveTelemetryOptions()).toEqual({
      endpoint: 'http://env.test:4318',
      headers: { authorization: 'env-token' },
      exportEnabled: false,
      stdoutLogLevel: 'warn',
      metricExportIntervalMillis: 2500,
    });
    expect(resolveTelemetryOptions({ endpoint: 'http://cli.test:4318', exportEnabled: 'true' })).toMatchObject({
      endpoint: 'http://cli.test:4318',
      exportEnabled: true,
    });
  });

  it('rejects invalid telemetry settings before the app boots', () => {
    expect(() => resolveTelemetryOptions({ exportEnabled: 'yes' })).toThrow('OTLP export must be true or false');
    expect(() => resolveTelemetryOptions({ headers: 'not-a-header' })).toThrow('Invalid OTLP header');
    expect(() => resolveTelemetryOptions({ stdoutLogLevel: 'verbose' })).toThrow('Invalid OTLP stdout log level');
    expect(() => resolveTelemetryOptions({ metricExportIntervalMillis: '0' })).toThrow(
      'OTLP metric export interval must be a positive integer',
    );
  });
});

it('flushes a trace-correlated log, span, and metric before daemon stop returns', async () => {
  const received: { path: string; authorization: string | undefined; body: string }[] = [];
  let stdout = '';
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.resume();
    request.on('end', () => {
      received.push({ path: request.url ?? '', authorization: request.headers.authorization, body });
      response.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP listener');

  const script = [
    `import { initializeTelemetry, resolveTelemetryOptions } from '${telemetryUrl}';`,
    `import { context, metrics, trace } from '${apiUrl}';`,
    `import { logger } from '${loggerUrl}';`,
    `import { startOperation } from '${operationsUrl}';`,
    // A large interval keeps the periodic metric reader from firing (and its
    // tight export timeout from flaking under load) during the child's short
    // life: the flush under test is the deterministic shutdown `forceFlush`, so
    // the metrics still arrive without a racing periodic export polluting stderr.
    `const telemetry = initializeTelemetry(resolveTelemetryOptions({ endpoint: 'http://127.0.0.1:${address.port}', headers: 'authorization=smoke-token', metricExportIntervalMillis: '60000' }));`,
    "const span = trace.getTracer('smoke').startSpan('smoke-span'); context.with(trace.setSpan(context.active(), span), () => logger.info('smoke-log')); span.end();",
    "const success = startOperation({ type: 'smoke-success', attributes: {} }); success.end();",
    "const failure = startOperation({ type: 'smoke-failure', attributes: {} }); failure.fail('smoke failure');",
    "metrics.getMeter('smoke').createCounter('smoke_counter').add(1);",
    "await new Promise((resolve) => setTimeout(resolve, 40));",
    "process.once('SIGTERM', async () => { await telemetry.shutdown(); process.exit(0); });",
    "console.log('ready');",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { stdio: 'pipe' });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (chunk.toString().includes('ready')) resolve();
    });
    child.on('exit', (code) => reject(new Error(`Telemetry child exited before ready: ${code}`)));
  });
  const result = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on('exit', (code) => resolve({ code, stderr }));
  });
  const daemonDir = mkdtempSync(join(tmpdir(), 'harmonic-telemetry-'));
  writeDaemon(daemonDir, { pid: child.pid!, port: 4700, host: '127.0.0.1', startedAt: Date.now() });
  expect(await stopDaemon(daemonDir)).toBe(true);
  const childResult = await result;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

  expect(childResult).toEqual({ code: 0, stderr: '' });
  expect(received.map(({ path, authorization }) => ({ path, authorization }))).toEqual(
    expect.arrayContaining([
      { path: '/v1/traces', authorization: 'smoke-token' },
      { path: '/v1/logs', authorization: 'smoke-token' },
      { path: '/v1/metrics', authorization: 'smoke-token' },
    ]),
  );
  const logsPayload = received.find((request) => request.path === '/v1/logs')?.body;
  const metricsPayload = received.find((request) => request.path === '/v1/metrics')?.body;
  expect(logsPayload).toContain('smoke-log');
  expect(logsPayload).toMatch(/"traceId":"[^"]+"/);
  expect(logsPayload).toMatch(/"spanId":"[^"]+"/);
  expect(stdout).toContain('"message":"smoke-log"');
  expect(stdout).toMatch(/"traceId":"[^"]+"/);
  expect(stdout).toMatch(/"spanId":"[^"]+"/);
  expect(metricsPayload).toContain('harmonic.operations.completed');
  expect(metricsPayload).toContain('harmonic.operations.errors');
  expect(metricsPayload).toContain('harmonic.operations.duration');
  expect(metricsPayload).toContain('smoke-success');
  expect(metricsPayload).toContain('smoke-failure');
  expect(stdout).toContain('Operation metrics summary');
  expect(stdout).toContain('operation.count');
  expect(stdout).toContain('operation.error_count');
});
