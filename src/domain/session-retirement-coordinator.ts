import type { AttemptRow } from '../db/schema.js';
import type { SessionStore } from './sessions.js';
import type { AttemptStore } from './attempts.js';
import { forEachYielding } from '../reliability/yield.js';
import { startOperation } from '../telemetry/operations.js';
import {
  decideRetirement,
  DEFAULT_RETENTION,
  type RetentionConfig,
  type RetirementCause,
} from './session-retirement.js';

/** Removes a git worktree (`Git.removeWorktree`), injected. */
export type RemoveWorktree = (repoDir: string, worktreePath: string) => Promise<void>;

/** The settle-hook `AttemptSettleCoordinator` calls on every terminal Attempt disposition. */
export interface SessionRetirementHook {
  onAttemptSettled(run: AttemptRow, cause: RetirementCause, now?: number): Promise<void>;
}

/**
 * Session retirement — the sole owner of builder-worktree removal.
 * {@link onAttemptSettled} records the intent (marks the Session `idle` or
 * `retiring`); {@link drain} sweeps lapsed `idle` Sessions into `retiring`,
 * then removes every `retiring` Session's worktree and marks it `retired`.
 * `drain` never removes a worktree while any Attempt of the Session is still
 * `running`.
 */
export class SessionRetirementCoordinator {
  constructor(
    private readonly sessions: SessionStore,
    private readonly runs: AttemptStore,
    private readonly removeWorktree: RemoveWorktree,
    private readonly config: RetentionConfig = DEFAULT_RETENTION,
    private readonly clock: () => number = Date.now,
    /** Notified with the Session's latest Attempt when its worktree is actually
     * removed — the hook that records the Timeline's `retired` event. */
    private readonly onRetired?: (run: AttemptRow) => void,
  ) {}

  /**
   * Record the retirement intent for `run`'s Session from the settle `cause`.
   * A no-op when the Attempt has no Session, its Session is already
   * retiring/retired, or the Session row has gone.
   */
  async onAttemptSettled(run: AttemptRow, cause: RetirementCause, now: number = this.clock()): Promise<void> {
    if (run.sessionRowId == null) return;
    let session;
    try {
      session = await this.sessions.get(run.sessionRowId);
    } catch {
      return;
    }
    if (session.status === 'retiring' || session.status === 'retired') return;
    const action = decideRetirement(cause, now, this.config);
    if (action.kind === 'retire') {
      await this.sessions.beginRetiring(session.id, action.reason, now);
    } else {
      await this.sessions.markIdle(session.id, action.retireDeadline, action.reason, now);
    }
  }

  /**
   * Sweep `idle`-past-deadline Sessions into `retiring`, then remove every
   * `retiring` Session's builder worktree and mark it `retired`. Returns how
   * many Sessions it retired. Idempotent.
   */
  async drain(now: number = this.clock()): Promise<number> {
    const operation = startOperation({ type: 'session.retire', attributes: {} });
    try {
      const retired = await operation.run(() => this.drainSessions(now));
      operation.update({ 'session.retired.count': retired });
      operation.end();
      return retired;
    } catch (error) {
      operation.fail(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async drainSessions(now: number): Promise<number> {
    await forEachYielding(await this.sessions.listRetentionDue(now), async (session) => {
      await this.sessions.beginRetiring(session.id, session.retireReason ?? 'retention-ttl', now);
    });
    let retired = 0;
    await forEachYielding(await this.sessions.listRetiring(), async (session) => {
      if (await this.hasActiveRun(session.id)) return;
      if (session.worktreePath && session.worktreeRepoDir) {
        await this.removeWorktree(session.worktreeRepoDir, session.worktreePath).catch(() => {});
        const run = (await this.runs.listForSession(session.id)).at(-1);
        if (run) this.onRetired?.(run);
      }
      await this.sessions.markRetired(session.id, now);
      retired++;
    });
    return retired;
  }

  private async hasActiveRun(sessionRowId: number): Promise<boolean> {
    for (const run of await this.runs.listForSession(sessionRowId)) {
      if (run.state === 'running') return true;
    }
    return false;
  }
}
