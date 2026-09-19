#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dispatchCli } from './cli-dispatch.js';
import { productionCliDependencies, runCliCommand } from './cli-commands.js';
import { logger } from './logger.js';

const argv = process.argv.slice(2);
const deps = productionCliDependencies({ cliEntryPath: fileURLToPath(import.meta.url) });

runCliCommand(dispatchCli(argv), argv.slice(1), deps)
  .then((outcome) => { if (outcome.kind === 'exit') process.exit(outcome.code); })
  .catch((error: unknown) => {
    logger.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
