import { readFileSync } from 'node:fs';

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

/** /proc/<pid>/stat field 22 (starttime), or null if the process is gone/unreadable. */
export function readProcStartToken(pid: number): string | null {
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

/** Current process's group id, from /proc/self/stat field 5 (pgrp). */
export function readSelfPgid(): number {
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
