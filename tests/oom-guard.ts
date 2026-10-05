import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// One vitest run at a time. Each fork boots full servers (Fastify + libsql + a
// stats worker); two concurrent runs — e.g. parallel test-running subagents —
// out-run memory and OOM-kill the box, silently dropping whichever files the
// reaped forks held. maxWorkers bounds a single run; this bounds the machine to
// one run. Stale locks self-heal: a dead holder's lock is stolen.
const LOCK = join(tmpdir(), 'harmonic-vitest.lock');

function holderAlive(pid: number): boolean {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function setup(): void {
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, 'utf8').trim());
    if (holderAlive(pid)) {
      throw new Error(
        `Another vitest run (pid ${pid}) is active. Run Harmonic tests one at a time — ` +
          `concurrent runs OOM the box (AGENTS.md > Testing).`,
      );
    }
  }
  writeFileSync(LOCK, String(process.pid));
}

export function teardown(): void {
  try {
    if (existsSync(LOCK) && Number(readFileSync(LOCK, 'utf8').trim()) === process.pid) {
      rmSync(LOCK);
    }
  } catch {
    // best effort — a leftover lock from our own pid self-heals next run
  }
}
