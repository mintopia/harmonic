/**
 * Git-failure classification + a per-context circuit breaker (issue #199).
 *
 * A Run driver spawns git to prepare its workspace (`git worktree add`, a
 * direct-mode detach, …). When such a command *fast-fails* — e.g. a worktree op
 * against a detached or dirty base — the scheduler's re-pick / re-drive machinery
 * would otherwise retry it on the very next event-loop tick, forever: a flood of
 * short-lived `git` children (~6/s observed) that piles up unreaped zombies and
 * starves the event loop until the whole server hangs.
 *
 * This module is the pure decision half of the fix (house style: a pure domain
 * seam, wired into the Runner/Auto-Runner separately):
 *
 *   1. {@link classifyGitFailure} splits a git failure into `permanent`
 *      (will-never-succeed with the same inputs — a detached/dirty base, a path
 *      that already exists, a bad revision) versus `transient` (a lock
 *      collision, a blip — a retry may win). A permanent failure must escalate
 *      to a human immediately rather than be retried at all.
 *   2. {@link breakerStep}/{@link breakerAllows} are a pure exponential-backoff
 *      reducer, and {@link GitCircuitBreaker} the thin per-context (base-repo)
 *      holder over it: consecutive git fast-fails on the same context back off
 *      exponentially, and after {@link BreakerConfig.threshold} of them the
 *      circuit *opens* so the caller parks/escalates the context instead of
 *      spinning. A success clears it.
 */

export type GitFailureClass = 'permanent' | 'transient';

/**
 * Lowercase substrings that mark a git failure as permanent: re-running the
 * identical command against the identical repository state cannot succeed, so
 * retrying only burns fork/exec cycles. Kept deliberately conservative —
 * anything not on this list is treated as transient and merely backed off (see
 * {@link classifyGitFailure}), never hard-escalated on a guess.
 */
const PERMANENT_MARKERS: readonly string[] = [
  // A worktree/detach op against a detached HEAD or an explicit bad base.
  'head is detached',
  'detached head',
  // `git worktree add <path>` / `git branch <name>` onto something already there.
  'already exists',
  'already checked out',
  'is already used by worktree',
  // A base revision that does not resolve — the caller passed a bad start point.
  'not a valid object name',
  'invalid reference',
  'unknown revision',
  'bad revision',
  'ambiguous argument',
  'needed a single revision',
  // The tree is dirty in a way the op refuses to clobber.
  'local changes to the following files would be overwritten',
  'would be overwritten by',
  'contains modified or untracked files',
  'please commit your changes or stash them',
  // Not a git repository at all — no amount of retrying makes it one.
  'not a git repository',
];

/**
 * Classify a git failure from its stderr/message. Returns `permanent` when the
 * failure will never succeed on a plain retry — the caller should escalate/park
 * rather than loop — and `transient` otherwise. Fails *open* to `transient`: an
 * unrecognised message is backed off by the circuit breaker rather than
 * hard-escalated, so a genuinely recoverable blip still gets its retries, just
 * not at fork-rate.
 */
export function classifyGitFailure(stderr: string): GitFailureClass {
  const haystack = (stderr ?? '').toLowerCase();
  return PERMANENT_MARKERS.some((marker) => haystack.includes(marker)) ? 'permanent' : 'transient';
}

/** Per-context circuit-breaker state: how many consecutive failures, and the
 * epoch-ms instant before which the context is backed off (half-open at it). */
export interface BreakerState {
  fails: number;
  openUntil: number;
}

export interface BreakerConfig {
  /** Consecutive failures at which the circuit opens (caller escalates). */
  threshold: number;
  /** Backoff for the first failure; doubles each subsequent one. */
  baseMs: number;
  /** Ceiling the doubling backoff is clamped to. */
  maxMs: number;
}

export const INITIAL_BREAKER: BreakerState = { fails: 0, openUntil: 0 };

/**
 * The production breaker tuning. `baseMs` is comfortably above a git fast-fail's
 * sub-millisecond turnaround, so even the *first* retry of a doomed context is
 * spaced by half a second (vs the old next-tick spin), and three strikes open
 * the circuit — turning an unbounded flood into at most a handful of spaced,
 * bounded attempts before a human is asked.
 */
export const DEFAULT_GIT_BREAKER: BreakerConfig = { threshold: 3, baseMs: 500, maxMs: 30_000 };

/** Whether a context is admissible now — true once `now` reaches its
 * `openUntil` (a never-failed context is always admissible). */
export function breakerAllows(state: BreakerState, now: number): boolean {
  return now >= state.openUntil;
}

/**
 * Fold one outcome into a context's breaker state. On `failure`: increment the
 * consecutive-failure count, arm an exponential backoff window
 * (`baseMs · 2^(fails-1)`, clamped to `maxMs`), and report `opened` once the
 * threshold is reached. On `success`: reset to {@link INITIAL_BREAKER}. Pure —
 * `now` is injected, no clock read.
 */
export function breakerStep(
  state: BreakerState,
  event: 'success' | 'failure',
  now: number,
  cfg: BreakerConfig,
): { state: BreakerState; backoffMs: number; opened: boolean } {
  if (event === 'success') {
    return { state: { ...INITIAL_BREAKER }, backoffMs: 0, opened: false };
  }
  const fails = state.fails + 1;
  const backoffMs = Math.min(cfg.baseMs * 2 ** (fails - 1), cfg.maxMs);
  const next: BreakerState = { fails, openUntil: now + backoffMs };
  return { state: next, backoffMs, opened: fails >= cfg.threshold };
}

/**
 * A thin, mutable per-context holder over the pure {@link breakerStep} reducer,
 * keyed by an opaque string (the Runner keys it on the base-repo identity, so
 * concurrent worktree/direct Runs colliding on the same repo share one breaker).
 * The clock is injected for tests.
 */
export class GitCircuitBreaker {
  private readonly states = new Map<string, BreakerState>();

  constructor(
    private readonly cfg: BreakerConfig = DEFAULT_GIT_BREAKER,
    private readonly clock: () => number = Date.now,
  ) {}

  private stateFor(key: string): BreakerState {
    return this.states.get(key) ?? INITIAL_BREAKER;
  }

  /** Whether a fresh git-spawning attempt on `key` is admissible now (not in a
   * backoff window). */
  allows(key: string): boolean {
    return breakerAllows(this.stateFor(key), this.clock());
  }

  /** Record a git fast-fail on `key`; returns whether the circuit just opened
   * (caller should escalate/park the context) and the armed backoff. */
  recordFailure(key: string): { opened: boolean; backoffMs: number } {
    const r = breakerStep(this.stateFor(key), 'failure', this.clock(), this.cfg);
    this.states.set(key, r.state);
    return { opened: r.opened, backoffMs: r.backoffMs };
  }

  /** Record a successful git-backed workspace prep on `key`, clearing any
   * accumulated backoff so a later unrelated blip starts from a clean slate. */
  recordSuccess(key: string): void {
    this.states.delete(key);
  }
}
