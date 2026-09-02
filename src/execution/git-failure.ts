export type GitFailureClass = 'permanent' | 'transient';

const PERMANENT_MARKERS: readonly string[] = [
  'head is detached',
  'detached head',
  'already exists',
  'already checked out',
  'is already used by worktree',
  'not a valid object name',
  'invalid reference',
  'unknown revision',
  'bad revision',
  'ambiguous argument',
  'needed a single revision',
  'local changes to the following files would be overwritten',
  'would be overwritten by',
  'contains modified or untracked files',
  'please commit your changes or stash them',
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

/** The production breaker tuning: three strikes open the circuit. */
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
 * concurrent worktree/direct Attempts colliding on the same repo share one breaker).
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
