import type { RunStore } from './runs.js';
import type { TaskService } from './tasks.js';
import type { SessionStore } from './sessions.js';
import type { TurnQueueStore } from './turn-queue-store.js';
import type { RunFactStore } from './run-facts.js';
import type { SessionRow } from '../db/schema.js';
import { assessResumeEligibility, sessionFacts, type ResumeEnvironment } from './session-resume.js';
import { buildResumeFallbackSummary, classifyReloadFailure } from './session-fallback.js';
import { repoKey } from '../execution/repo-lock.js';
import { forEachYielding, type YieldOptions } from '../reliability/yield.js';
import { startOperation } from '../telemetry/operations.js';

/** The capability half of the resume environment — every axis of the
 * compatibility key except cwd, which the coordinator owns (it canonicalises the
 * stored and current work-context identities itself, from independent sources).
 * Injected so the pure decision stays independent of how these are resolved
 * (config/harness registry live in `app.ts`; a test passes a stub). */
export type ResumeCapabilities = Omit<ResumeEnvironment, 'cwd'>;

/**
 * Resume a crash/restart-interrupted Run as a **new Run + a new prompt turn on a
 * loaded Session** (issue #146, reliability-design Unit C) — the operator-facing
 * payoff of the resume unit (parent #110). A Run whose process a restart killed
 * mid-conversation is failed `interrupted` by the generic orphan sweep
 * (`RunStore.markInterrupted`); this coordinator runs *after* that sweep (and
 * after the whole crash-recovery reconciliation — landing/queue/lease — so it
 * acts only on a reconciled repository) and, for each such Run that was bound to
 * a durable Session, does the one thing the design mandates:
 *
 *   1. Decide, from the pure compatibility matrix (`assessResumeEligibility`,
 *      #142), whether the stored Session can be reloaded into the current
 *      environment. A model change never blocks; a harness/adapter/cwd/permission
 *      drift does.
 *   2. Create a **new** Run off the same Task (a fresh attempt, sharing the
 *      Execution Chain so spend accounting carries over).
 *   3. Bind it and enqueue a `crash-recovery` prompt turn on the **spine
 *      per-Session turn queue** (single-flight, #116) — never a direct driver
 *      call, never a process reattach:
 *        - **compatible → resume the same Session**: the new Run binds to the
 *          same `sessionRowId`/harness session id, and the turn is enqueued on
 *          that harness session id so a later dispatch reloads it via
 *          `session/load`.
 *        - **incompatible → fail forward**: the incompatibility reason is
 *          persisted on the dead Session (#145 AC5), the new Run is seeded with a
 *          deterministic Harmonic-authored summary (`buildResumeFallbackSummary`,
 *          #145) as its opening prompt, bound to no prior Session, and the turn is
 *          enqueued on a fresh per-Run queue id so a later dispatch spawns a fresh
 *          Session seeded with that summary.
 *
 * **Idempotent (AC3).** The interrupted Run is stamped `session-resumed` and the
 * new Run `resume-entry`; a Run carrying either marker is skipped, so a repeated
 * recovery — a second call in one boot, or a later boot — creates no duplicate
 * Run and no duplicate turn. (The crash-recovery turn it enqueues is excluded
 * from the crash-recovery queue-cancellation sweep for the same reason: it is the
 * resume re-entry, meant to survive into the next running process, not a stale
 * in-flight turn — see `CrashRecoveryCoordinator.reconcileTurnQueue`.)
 */
export class BootResumeCoordinator {
  constructor(
    private readonly runStore: RunStore,
    private readonly taskService: TaskService,
    private readonly sessionStore: SessionStore,
    private readonly turnQueue: TurnQueueStore,
    private readonly runFacts: RunFactStore,
    /** The capability axes a reload would target, computed fresh per Session
     * (current adapter version, model, live permission modes). The coordinator
     * supplies the cwd axis itself — see {@link ResumeCapabilities}. */
    private readonly resolveCapabilities: (session: SessionRow) => ResumeCapabilities,
    private readonly opts: { now?: () => number; yielding?: YieldOptions } = {},
  ) {}

  /** Resume every interrupted, Session-bound Run not already resumed. Safe to
   * call repeatedly (idempotent — see the class doc comment). */
  async resume(now?: number): Promise<void> {
    const operation = startOperation({ type: 'startup.boot-resume', attributes: {} });
    try {
      await operation.run(() => this.resumeInterrupted(now));
      operation.end();
    } catch (error) {
      operation.fail(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async resumeInterrupted(now?: number): Promise<void> {
    const ts = now ?? (this.opts.now ?? Date.now)();
    await forEachYielding(await this.runStore.listResumableInterrupted(), async (orphan) => {
      if (await this.alreadyHandled(orphan.id)) return; // once-only (AC3)
      if (orphan.sessionRowId === null) return; // narrowing; the query already excludes null

      const session = await this.sessionStore.get(orphan.sessionRowId);
      const task = await this.taskService.get(orphan.taskId);
      // The cwd / Work-Context axis compares two INDEPENDENT operands, each run
      // through `repoKey` (the canonicaliser the seam contract mandates): the
      // Session's recorded work-context identity vs. where the Task would execute
      // now. A workspace moved or a Task re-pointed since dispatch surfaces here as
      // a `cwd-mismatch` → fresh Session, rather than resuming a conversation
      // against a different working tree.
      const env: ResumeEnvironment = { ...this.resolveCapabilities(session), cwd: repoKey(task.workingDir) };
      const stored = { ...sessionFacts(session), cwd: repoKey(session.cwd) };
      const eligibility = assessResumeEligibility(stored, env);

      // The new Run is a fresh attempt of the same Task, on the same Execution
      // Chain (#129) so a resume can't reset the cumulative spend budget.
      const resumeRun = await this.runStore.create(orphan.taskId, undefined, orphan.chainId ?? undefined);

      if (eligibility.eligible) {
        // Resume the same Session: bind the new Run to it and enqueue the
        // re-entry turn on its harness session id, for a later `session/load`.
        await this.runStore.update(resumeRun.id, {
          sessionRowId: session.id,
          sessionId: session.harnessSessionId,
          prompt: CRASH_RECOVERY_PROMPT,
        });
        await this.turnQueue.enqueue(session.harnessSessionId, resumeRun.id, 'crash-recovery', {}, ts);
      } else {
        // Fail forward: record why on the dead Session, seed the new Run with a
        // deterministic summary Harmonic built from its own records (never the
        // dead Session's own words), and enqueue the re-entry turn on a fresh
        // per-Run queue id — a later dispatch spawns a fresh Session for it.
        await this.sessionStore.recordResumeIncompatibility(session.id, eligibility.reason, eligibility.detail, ts);
        const failure = classifyReloadFailure(eligibility.reason, eligibility.detail);
        const summary = buildResumeFallbackSummary({
          trigger: failure.reason,
          detail: failure.detail,
          session: {
            harness: session.harness,
            model: session.model,
            cwd: session.cwd,
            harnessSessionId: session.harnessSessionId,
          },
          candidate: { oid: orphan.candidateOid, status: orphan.reason },
          facts: await this.runFacts.list(orphan.id),
          events: await this.runStore.listEvents(orphan.id),
          trackerLinks: [],
        });
        await this.runStore.update(resumeRun.id, { prompt: summary });
        // A Session-less Run anchors its turn queue on its globally-unique Run id
        // (`run-<id>`), the same convention the drive loop uses (`runner.ts`'s
        // `sessionKey`), so a later dispatch finds this queue where it looks for
        // every other fresh Run's — the real harness session id is adopted once
        // `session/new` returns for the fresh Session.
        await this.turnQueue.enqueue(`run-${resumeRun.id}`, resumeRun.id, 'crash-recovery', {}, ts);
      }

      // The idempotency ledger (AC3): the interrupted Run records the new Run it
      // resumed into; the new Run records the interrupted Run it continues. Either
      // marker makes a Run un-resumable on a later boot.
      await this.runFacts.append(orphan.id, 'session-resumed', { resumedAsRunId: resumeRun.id, action: eligibility.eligible ? 'resume-same-session' : 'fail-forward' }, ts);
      await this.runFacts.append(resumeRun.id, 'resume-entry', { resumedFromRunId: orphan.id }, ts);

      // The Task continues as live work rather than staying failed from the boot
      // orphan-fail sweep — the resume Run is its live attempt now, parked
      // awaiting dispatch (the `resume-entry` marker keeps that Run, and this
      // `running` Task, from being re-orphaned on a later boot — see
      // `RunStore.markInterrupted` and the boot Task sweep in `app.ts`).
      await this.taskService.setState(orphan.taskId, 'running');
    }, this.opts.yielding);
  }

  /** Whether `runId` is already part of a resume — it was resumed
   * (`session-resumed`) or it *is* a resume re-entry (`resume-entry`). Either way
   * it must not be resumed again (AC3). */
  private async alreadyHandled(runId: number): Promise<boolean> {
    return (await this.runFacts.list(runId)).some((fact) => fact.type === 'session-resumed' || fact.type === 'resume-entry');
  }
}

/**
 * The canned crash-recovery re-entry prompt sent when the prior Session is
 * reloaded intact (issue #146). Deliberately fixed text — the idempotency of the
 * recovery prompt (AC3) is the coordinator's marker-fact guard, not a per-boot
 * variation in this string; a reloaded Session already holds the full prior
 * conversation, so the re-entry only has to tell the agent it was interrupted and
 * to continue. (The fail-forward path seeds `buildResumeFallbackSummary` instead,
 * because that Session has no prior context to reload.)
 */
export const CRASH_RECOVERY_PROMPT =
  'This run was interrupted by a Harmonic restart and has been resumed. Your prior ' +
  'conversation has been reloaded — review where you left off and continue the task ' +
  'from there. Do not restart work you have already completed.';
