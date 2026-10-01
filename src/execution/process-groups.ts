import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { eq } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { processGroups } from '../db/schema.js';
import { fireAndForget, reportFailure } from '../error-handling.js';
import { logger } from '../logger.js';
import { forEachYielding, type YieldOptions } from '../reliability/yield.js';
import { ProcGroupReaper, readProcStartToken, type ProcessReaper } from './process-reaper.js';

/** Persists every spawned process group so a boot after a crash can reap the ones left running. */
export class ProcessGroupJournal {
  constructor(
    private readonly db: AsyncDbHandle,
    private readonly reaper: ProcessReaper = new ProcGroupReaper(),
  ) {}

  async record(pgid: number, owner: string): Promise<number | undefined> {
    const startToken = readProcStartToken(pgid);
    if (startToken === null) return undefined;
    const row = await this.db.write((d) => d.insert(processGroups).values({ pgid, startToken, owner, startedAt: Date.now() }).returning({ id: processGroups.id }).get());
    return row.id;
  }

  async forget(id: number): Promise<void> {
    await this.db.write((d) => d.delete(processGroups).where(eq(processGroups.id, id)).run());
  }

  /** Boot only, before this instance spawns anything: every journaled group belongs to a dead predecessor. */
  async reapOrphans(yieldOptions?: YieldOptions): Promise<void> {
    const rows = await this.db.read((d) => d.select().from(processGroups).all());
    await forEachYielding(rows, async (row) => {
      const outcome = await this.reaper.reap({ pgid: row.pgid, startToken: row.startToken });
      logger.info('crash-recovery: reaping orphan process group', { owner: row.owner, pgid: row.pgid, outcome });
      await this.forget(row.id);
    }, yieldOptions);
  }
}

let journal: ProcessGroupJournal | undefined;

/** Process groups are per OS process, so one journal serves the whole process; the app attaches it after the boot reap. */
export function attachProcessGroupJournal(next: ProcessGroupJournal): void {
  journal = next;
}

export function detachProcessGroupJournal(owner: ProcessGroupJournal): void {
  if (journal === owner) journal = undefined;
}

export function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    /* group already gone */
  }
}

/** Kill `child` and every descendant it started. */
export function killProcessGroup(child: ChildProcess): void {
  if (child.pid !== undefined) signalProcessGroup(child.pid, 'SIGKILL');
  else if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
}

/** Spawn `command` as its own process-group leader; the group is journaled until the leader exits, then killed whole. */
export function spawnProcessGroup(command: string, args: readonly string[], options: SpawnOptions, owner: string): ChildProcess {
  const child = spawn(command, args, { ...options, detached: true });
  const pgid = child.pid;
  if (pgid === undefined) return child;
  const recorder = journal;
  const recorded = recorder?.record(pgid, owner).catch((error: unknown) => {
    reportFailure(error, { op: 'processGroups.record', level: 'warn', context: { owner, pgid } });
    return undefined;
  });
  child.once('exit', () => {
    signalProcessGroup(pgid, 'SIGKILL');
    if (!recorder || !recorded) return;
    fireAndForget(async () => {
      const id = await recorded;
      if (id !== undefined) await recorder.forget(id);
    }, { op: 'processGroups.forget', level: 'warn', context: { owner, pgid } });
  });
  return child;
}
