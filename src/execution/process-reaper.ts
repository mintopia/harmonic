import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const isLinux = process.platform === 'linux';

/** One numeric/string ps field for a pid, or null if the process is gone (ps exits non-zero). */
function psField(pid: number, field: 'lstart' | 'pgid'): string | null {
  try {
    const out = execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const value = out.trim();
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

export interface ProcessIdentity {
  pid: number;
  pgid: number;
  /** /proc/<pid>/stat field 22 (starttime, clock ticks since boot). */
  startToken: string;
}
export type ReapOutcome = 'reaped' | 'not-running' | 'identity-mismatch' | 'refused-self-group';
export interface ReapOptions {
  termGraceMs?: number;
  pollMs?: number;
}

/** A start-time token that pins pid identity against reuse, or null if the process is gone. Linux: /proc/<pid>/stat field 22 (starttime). macOS/BSD: ps lstart (process start timestamp). */
export function readProcStartToken(pid: number): string | null {
  if (!isLinux) return psField(pid, 'lstart');
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // comm (field 2) is parenthesised and may contain spaces/parens; skip past its closing ')'.
  const afterComm = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  return afterComm[19] ?? null; // afterComm[0] is field 3 (state); starttime is field 22.
}

/** Current process's group id. Linux: /proc/self/stat field 5 (pgrp). macOS/BSD: ps pgid, falling back to our pid (a detached leader's pgid equals its pid) if ps is unavailable. */
export function readSelfPgid(): number {
  if (!isLinux) {
    const pgid = psField(process.pid, 'pgid');
    return pgid === null ? process.pid : Number(pgid);
  }
  const stat = readFileSync('/proc/self/stat', 'utf8');
  const afterComm = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  return Number(afterComm[2] ?? NaN); // field 5 (pgrp).
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ProcessReaper {
  reap(identity: ProcessIdentity, options?: ReapOptions): Promise<ReapOutcome>;
}

/** Terminates a persisted harness process group, fail-closed: only when the live /proc start-time still matches the persisted token, and never our own group. Bounded SIGTERM then SIGKILL over the group. */
export class ProcGroupReaper implements ProcessReaper {
  constructor(private readonly selfPgid: number = readSelfPgid()) {}

  async reap(identity: ProcessIdentity, options: ReapOptions = {}): Promise<ReapOutcome> {
    const { pid, pgid, startToken } = identity;
    if (!Number.isInteger(pgid) || pgid <= 1 || pgid === this.selfPgid) return 'refused-self-group';
    const live = readProcStartToken(pid);
    if (live === null) return 'not-running';
    if (live !== startToken) return 'identity-mismatch';
    const termGraceMs = options.termGraceMs ?? 5000;
    const pollMs = options.pollMs ?? 50;
    // ponytail: on macOS each poll forks `ps`; fine for this rare boot-time reap, switch to a batched liveness check if it ever runs hot.
    this.signalGroup(pgid, 'SIGTERM');
    const deadline = Date.now() + termGraceMs;
    while (Date.now() < deadline) {
      if (readProcStartToken(pid) !== startToken) return 'reaped';
      await delay(pollMs);
    }
    if (readProcStartToken(pid) === startToken) this.signalGroup(pgid, 'SIGKILL');
    return 'reaped';
  }

  private signalGroup(pgid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pgid, signal);
    } catch {
      /* group already gone */
    }
  }
}
