import { startStartupWatchdog } from '../../src/cli-serve.js';

const dataDir = process.argv[2];
if (!dataDir) throw new Error('usage: startup-watchdog-hang <dataDir>');

startStartupWatchdog({ dataDir });
process.stdout.write('armed\n');

// Simulates a release that imports fine but hangs before `listen` (e.g. stuck DB init): keeps the
// event loop alive (like a real pending DB call would) without ever completing.
setInterval(() => {}, 1000);
