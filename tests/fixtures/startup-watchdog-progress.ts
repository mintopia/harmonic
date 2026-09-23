import { fileURLToPath } from 'node:url';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { startStartupWatchdog } from '../../src/cli-serve.js';
import { touchStartupProgress } from '../../src/reliability/startup-progress.js';

const dataDirArg = process.argv[2];
const deadlineMs = Number(process.argv[3]);
const totalMs = Number(process.argv[4]);
if (!dataDirArg || !Number.isFinite(deadlineMs) || !Number.isFinite(totalMs)) {
  throw new Error('usage: startup-watchdog-progress <dataDir> <deadlineMs> <totalMs>');
}
const dataDir: string = dataDirArg;

const watcherPath = fileURLToPath(new URL('../../src/upgrade/startup-watcher.cjs', import.meta.url));
startStartupWatchdog({ dataDir, deadlineMs, watcherPath });
process.stdout.write('armed\n');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function main(): Promise<void> {
  const stepMs = deadlineMs / 2;
  let elapsed = 0;
  while (elapsed < totalMs) {
    await sleep(stepMs);
    elapsed += stepMs;
    touchStartupProgress(dataDir);
  }
  unlinkSync(join(dataDir, 'app', 'pending.json'));
  process.stdout.write('healthy\n');
}

void main();
