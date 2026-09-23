import { fileURLToPath } from 'node:url';
import { startStartupWatchdog } from '../../src/cli-serve.js';

const dataDir = process.argv[2];
if (!dataDir) throw new Error('usage: startup-watchdog-hang <dataDir>');

const watcherPath = fileURLToPath(new URL('../../src/upgrade/startup-watcher.cjs', import.meta.url));
startStartupWatchdog({ dataDir, watcherPath });
process.stdout.write('armed\n');

const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
}
