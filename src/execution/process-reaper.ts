import { readdirSync, readFileSync } from 'node:fs';
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

/** Fields after the parenthesised comm (field 2), which may itself contain spaces and parens; index 0 is field 3. */
function statFields(stat: string): string[] {
  return stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
}

/** A start-time token that pins pid identity against reuse, or null if the process is gone. Linux: /proc/<pid>/stat field 22 (starttime). macOS/BSD: ps lstart (process start timestamp). */
export function readProcStartToken(pid: number): string | null {
  if (!isLinux) return psField(pid, 'lstart');
  try {
    return statFields(readFileSync(`/proc/${pid}/stat`, 'utf8'))[19] ?? null;
  } catch {
    return null;
  }
}

/** A start token as an orderable number (Linux clock ticks since boot, macOS epoch ms), or null when unreadable. */
export function startOrder(token: string): number | null {
  const value = isLinux ? Number(token) : Date.parse(token);
  return Number.isFinite(value) ? value : null;
}

/** Current process's group id. Linux: /proc/self/stat field 5 (pgrp). macOS/BSD: ps pgid, falling back to our pid (a detached leader's pgid equals its pid) if ps is unavailable. */
export function readSelfPgid(): number {
  if (!isLinux) {
    const pgid = psField(process.pid, 'pgid');
    return pgid === null ? process.pid : Number(pgid);
  }
  return Number(statFields(readFileSync('/proc/self/stat', 'utf8'))[2] ?? NaN);
}

export interface ProcessStart {
  pid: number;
  pgid: number;
  /** {@link startOrder} of the process's start token. */
  start: number;
}

/** Every live process with a readable pgid and start time; processes that vanish or can't be read are left out, never guessed. Null if the table itself is unreadable. */
export function readProcessTable(): ProcessStart[] | null {
  if (!isLinux) {
    let out: string;
    try {
      out = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
    const table: ProcessStart[] = [];
    for (const line of out.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      const start = match ? startOrder(match[3]!) : null;
      if (match && start !== null) table.push({ pid: Number(match[1]), pgid: Number(match[2]), start });
    }
    return table;
  }
  let entries: string[];
  try {
    entries = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return null;
  }
  const table: ProcessStart[] = [];
  for (const name of entries) {
    let fields: string[];
    try {
      fields = statFields(readFileSync(`/proc/${name}/stat`, 'utf8'));
    } catch {
      continue;
    }
    const pgid = Number(fields[2]);
    const start = Number(fields[19]);
    if (Number.isInteger(pgid) && Number.isFinite(start)) table.push({ pid: Number(name), pgid, start });
  }
  return table;
}

export interface ProcessIdentity {
  /** The group leader's pid; harness groups are spawned detached, so pid === pgid. */
  pgid: number;
  /** The leader's {@link readProcStartToken} at spawn. */
  startToken: string;
}
export type ReapOutcome = 'reaped' | 'not-running' | 'identity-mismatch' | 'refused-self-group' | 'unreadable';
export interface ReapOptions {
  termGraceMs?: number;
  pollMs?: number;
  /** A process table already read by the caller, so a batch of reaps shares one read; null means unreadable. Read fresh when omitted. */
  processTable?: readonly ProcessStart[] | null;
}

export type ReapTargets = { kind: 'reap'; members: ProcessStart[] } | { kind: 'skip'; outcome: 'not-running' | 'identity-mismatch' };

/** The live members of a recorded group: a live leader must match its recorded start (else the pgid was reused); a leaderless member must have started between the leader and this boot. */
export function reapTargets(recorded: { pgid: number; start: number }, table: readonly ProcessStart[], selfStart: number): ReapTargets {
  const inGroup = table.filter((proc) => proc.pgid === recorded.pgid);
  const leader = table.find((proc) => proc.pid === recorded.pgid);
  if (leader) {
    return leader.pgid === recorded.pgid && leader.start === recorded.start ? { kind: 'reap', members: inGroup } : { kind: 'skip', outcome: 'identity-mismatch' };
  }
  const members = inGroup.filter((proc) => proc.start >= recorded.start && proc.start < selfStart);
  if (members.length > 0) return { kind: 'reap', members };
  return { kind: 'skip', outcome: inGroup.length > 0 ? 'identity-mismatch' : 'not-running' };
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ProcessReaper {
  reap(identity: ProcessIdentity, options?: ReapOptions): Promise<ReapOutcome>;
}

/** Terminates a recorded process group left by a crashed instance, fail-closed via {@link reapTargets} and never our own group. Bounded SIGTERM then SIGKILL. */
export class ProcGroupReaper implements ProcessReaper {
  constructor(private readonly selfPgid: number = readSelfPgid()) {}

  async reap(identity: ProcessIdentity, options: ReapOptions = {}): Promise<ReapOutcome> {
    const { pgid, startToken } = identity;
    if (!Number.isInteger(pgid) || pgid <= 1 || pgid === this.selfPgid) return 'refused-self-group';
    const recordedStart = startOrder(startToken);
    const selfToken = readProcStartToken(process.pid);
    const selfStart = selfToken === null ? null : startOrder(selfToken);
    const table = options.processTable === undefined ? readProcessTable() : options.processTable;
    if (recordedStart === null || selfStart === null || table === null) return 'unreadable';
    const targets = reapTargets({ pgid, start: recordedStart }, table, selfStart);
    if (targets.kind === 'skip') return targets.outcome;
    const signal = (sig: NodeJS.Signals): void => {
      for (const member of targets.members) if (this.stillSame(member)) this.send(member.pid, sig);
    };
    signal('SIGTERM');
    const deadline = Date.now() + (options.termGraceMs ?? 5000);
    while (Date.now() < deadline) {
      if (!targets.members.some((member) => this.stillSame(member))) return 'reaped';
      await delay(options.pollMs ?? 50);
    }
    signal('SIGKILL');
    return 'reaped';
  }

  private stillSame(proc: ProcessStart): boolean {
    const token = readProcStartToken(proc.pid);
    return token !== null && startOrder(token) === proc.start;
  }

  private send(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}
