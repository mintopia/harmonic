#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { buildApp } from './server/app.js';
import { defaultDataDir } from './config.js';

const HELP = `agentdeck — queue, run, and review autonomous agent tasks

Usage:
  agentdeck serve [--port <n>] [--host <h>] [--data-dir <dir>]

Options:
  --port      Port to listen on (default 4700)
  --host      Host to bind (default 127.0.0.1)
  --data-dir  State directory (default ~/.agentdeck, or $AGENTDECK_DATA_DIR)
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
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
    },
  });

  const dataDir = values['data-dir'] ?? defaultDataDir();
  const app = await buildApp({ dataDir });
  const port = Number(values.port);
  const host = values.host!;
  await app.listen({ port, host });
  console.log(`AgentDeck listening on http://${host}:${port} (data: ${dataDir})`);

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
