#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildApp } from './server/app.js';
import { defaultDataDir } from './config.js';
import { acquireLock, daemonStatus, logFilePath, releaseLock, stopDaemon, writeDaemon } from './daemon.js';

const HELP = `harmonic — queue, run, and review autonomous agent tasks

Usage:
  harmonic serve [--port <n>] [--host <h>] [--data-dir <dir>] [--password <pw>]
  harmonic start [--port <n>] [--host <h>] [--data-dir <dir>] [--password <pw>]
  harmonic status [--data-dir <dir>]
  harmonic stop [--data-dir <dir>]

Commands:
  serve       Run the server in the foreground
  start       Run the server in the background (logs to <data-dir>/harmonic.log)
  status      Show whether a background server is running
  stop        Stop the background server

Options:
  --port, -p  Port to listen on (default 4700)
  --host, -H  Host to bind (default 0.0.0.0)
  --data-dir  State directory (default ~/.harmonic, or $HARMONIC_DATA_DIR)
  --password  Set/update the operator password (or $HARMONIC_PASSWORD).
              Optional; pass an empty value (--password '') to remove it and
              run ungated
`;

/** 0.0.0.0 binds everywhere but isn't a clickable URL — show localhost. */
const displayUrl = (host: string, port: number) =>
  `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === 'status' || command === 'stop') {
    const { values } = parseArgs({ args: rest, options: { 'data-dir': { type: 'string' } } });
    const dataDir = values['data-dir'] ?? defaultDataDir();
    if (command === 'stop') {
      console.log((await stopDaemon(dataDir)) ? 'Stopped.' : 'Not running.');
      return;
    }
    const { running, info } = daemonStatus(dataDir);
    if (!running || !info) {
      console.log('Not running.');
      process.exit(1);
    }
    console.log(
      `Running (pid ${info.pid}) — ${displayUrl(info.host, info.port)}, ` +
        `up since ${new Date(info.startedAt).toLocaleString()}\nLogs: ${logFilePath(dataDir)}`,
    );
    return;
  }

  if (command !== 'serve' && command !== 'start') {
    process.stdout.write(HELP);
    process.exit(command === undefined || command === 'help' || command === '--help' ? 0 : 1);
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      port: { type: 'string', default: '4700' },
      host: { type: 'string', default: '0.0.0.0' },
      'data-dir': { type: 'string' },
      password: { type: 'string' },
    },
  });

  if (command === 'start') {
    const dataDir = values['data-dir'] ?? defaultDataDir();
    const port = Number(values.port);
    const host = values.host!;
    const existing = daemonStatus(dataDir);
    if (existing.running && existing.info) {
      console.error(
        `Already running (pid ${existing.info.pid}) — ${displayUrl(existing.info.host, existing.info.port)}. ` +
          '`harmonic stop` first.',
      );
      process.exit(1);
    }
    mkdirSync(dataDir, { recursive: true });
    const log = openSync(logFilePath(dataDir), 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', ...rest], {
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.unref();
    writeDaemon(dataDir, { pid: child.pid!, port, host, startedAt: Date.now() });
    // Give the child a moment so first-run mistakes (no password) fail loudly here.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (!daemonStatus(dataDir).running) {
      console.error(`Failed to start — see ${logFilePath(dataDir)}`);
      await stopDaemon(dataDir);
      process.exit(1);
    }
    console.log(
      `Harmonic running in the background (pid ${child.pid}) — ${displayUrl(host, port)}\n` +
        `Logs: ${logFilePath(dataDir)}\nStop with: harmonic stop`,
    );
    return;
  }

  const dataDir = values['data-dir'] ?? defaultDataDir();
  const port = Number(values.port);
  const host = values.host!;
  // Refuse to boot against a data dir a live instance holds — otherwise crash
  // recovery would mark the other instance's in-flight runs interrupted (#40).
  const holder = acquireLock(dataDir, { port, host });
  if (holder) {
    console.error(
      `Another Harmonic instance is using ${dataDir} (pid ${holder.pid}, ${displayUrl(holder.host, holder.port)}).\n` +
        '  Stop it first (harmonic stop), or use a different --data-dir.',
    );
    process.exit(1);
  }
  const password = values.password ?? process.env.HARMONIC_PASSWORD;
  const app = await buildApp({ dataDir, password });
  if (!app.ctx.auth.hasPassword()) {
    const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
    console.warn(
      `No operator password set — Harmonic is running ungated${loopback ? '' : ` and reachable on ${host}`}.\n` +
        (loopback ? '' : '  Anyone who can reach this address has full access. Bind to 127.0.0.1 or set a password.\n') +
        '  Set one any time: harmonic serve --password <password>   (or HARMONIC_PASSWORD)',
    );
  }
  await app.listen({ port, host });
  console.log(`Harmonic listening on ${displayUrl(host, port)} (bound to ${host}, data: ${dataDir})`);

  const shutdown = async () => {
    await app.close();
    releaseLock(dataDir);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
