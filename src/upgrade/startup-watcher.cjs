#!/usr/bin/env node
'use strict';

// Dependency-free, out-of-process readiness watchdog for a single boot attempt (ADR-0042). A
// synchronous startup hang blocks the server's own event loop, and with it any in-process timer,
// so this runs as a separate process (spawned non-detached, in the same cgroup) and force-kills
// the server if it never signals progress. systemd's default KillMode=control-group kills this
// alongside the unit; Restart=always then restarts a killed server. Exits 0 the moment protection
// is no longer needed, so it never lingers once the boot it's watching is no longer at risk.
//
// usage: startup-watcher.cjs <dataDir> <serverPid> <version> <deadlineMs>

const fs = require('node:fs');
const path = require('node:path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function main() {
  const [dataDir, pidArg, version, deadlineArg] = process.argv.slice(2);
  const serverPid = Number(pidArg);
  const deadlineMs = Number(deadlineArg);
  if (!dataDir || !Number.isInteger(serverPid) || !version || !Number.isFinite(deadlineMs)) {
    process.stderr.write('harmonic startup-watcher: usage: startup-watcher.cjs <dataDir> <serverPid> <version> <deadlineMs>\n');
    process.exitCode = 1;
    return;
  }
  // Refuse to watch unless our parent is the given pid, so we never risk killing an unrelated process.
  if (process.ppid !== serverPid) {
    process.stderr.write(`harmonic startup-watcher: refusing to watch pid ${serverPid}; it is not our parent (ppid ${process.ppid})\n`);
    process.exitCode = 1;
    return;
  }

  const appDir = path.join(dataDir, 'app');
  const pendingPath = path.join(appDir, 'pending.json');
  const progressPath = path.join(appDir, 'startup-progress');
  const startedAt = Date.now();
  const pollMs = Number(process.env.HARMONIC_STARTUP_WATCHER_POLL_MS) || 1000;

  function stillPending() {
    try {
      const pending = readJson(pendingPath);
      return Boolean(pending) && pending.version === version;
    } catch {
      return false;
    }
  }

  function lastProgressAt() {
    try {
      return fs.statSync(progressPath).mtimeMs;
    } catch {
      return startedAt;
    }
  }

  function stop() {
    clearInterval(interval);
  }

  const interval = setInterval(() => {
    // Server exited, or we were reparented away from it: nothing left to guard.
    if (process.ppid !== serverPid || !isAlive(serverPid)) {
      stop();
      return;
    }
    if (!stillPending()) {
      stop();
      return;
    }
    if (Date.now() - lastProgressAt() >= deadlineMs) {
      process.stderr.write(
        `harmonic startup-watcher: pid ${serverPid} made no startup progress for ${deadlineMs}ms while pending.json names its running version (${version}); killing it.\n`,
      );
      try {
        process.kill(serverPid, 'SIGKILL');
      } catch {
        // already gone
      }
      stop();
    }
  }, pollMs);
}

try {
  main();
} catch (error) {
  process.stderr.write(`harmonic startup-watcher: failed: ${error && error.message ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
