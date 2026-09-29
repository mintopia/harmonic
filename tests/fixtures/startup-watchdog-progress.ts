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
  // 1/8, not 1/2, of the deadline: under real scheduling jitter a touch can
  // land late, and a cadence that only halves the deadline leaves no room to
  // absorb that before the out-of-process watcher (polling independently)
  // decides the boot is hung.
  const stepMs = deadlineMs / 8;
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
