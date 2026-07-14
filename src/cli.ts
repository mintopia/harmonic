#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { buildApp } from './server/app.js';
import { defaultDataDir } from './config.js';

const HELP = `harmonic — queue, run, and review autonomous agent tasks

Usage:
  harmonic serve [--port <n>] [--host <h>] [--data-dir <dir>] [--password <pw>]
  harmonic init --repo <url|path> [--data-dir <dir>] [--password <pw>]

Options:
  --port      Port to listen on (default 4700)
  --host      Host to bind (default 127.0.0.1)
  --data-dir  State directory (default ~/.harmonic, or $HARMONIC_DATA_DIR)
  --password  Set/update the operator password (or $HARMONIC_PASSWORD);
              required on first run
  --username  Operator username (or $HARMONIC_USERNAME; default "operator")
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === 'init') {
    const { values } = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        'data-dir': { type: 'string' },
        password: { type: 'string' },
      },
    });
    if (!values.repo) {
      console.error('init requires --repo <url|path>');
      process.exit(1);
    }
    const dataDir = values['data-dir'] ?? defaultDataDir();
    const password = values.password ?? process.env.HARMONIC_PASSWORD;
    const app = await buildApp({ dataDir, password });
    const file = await app.ctx.configRepo.init(values.repo);
    await app.close();
    console.log(
      `Imported ${Object.keys(file).join(', ')} from ${values.repo} into ${dataDir}. ` +
        `Run \`harmonic serve\` to start.`,
    );
    return;
  }

  if (command !== 'serve') {
    process.stdout.write(HELP);
    process.exit(command === undefined || command === 'help' || command === '--help' ? 0 : 1);
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      port: { type: 'string', default: '4700' },
      host: { type: 'string', default: '127.0.0.1' },
      'data-dir': { type: 'string' },
      password: { type: 'string' },
      username: { type: 'string' },
    },
  });

  const dataDir = values['data-dir'] ?? defaultDataDir();
  const password = values.password ?? process.env.HARMONIC_PASSWORD;
  const username = values.username ?? process.env.HARMONIC_USERNAME;
  const app = await buildApp({ dataDir, password, username });
  if (!app.ctx.auth.hasPassword()) {
    console.error(
      'No operator password is set. First run requires one:\n' +
        '  harmonic serve --password <password>   (or HARMONIC_PASSWORD)',
    );
    process.exit(1);
  }
  const port = Number(values.port);
  const host = values.host!;
  await app.listen({ port, host });
  console.log(`Harmonic listening on http://${host}:${port} (data: ${dataDir})`);

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
