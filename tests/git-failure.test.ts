import { describe, it, expect } from 'vitest';
import {
  classifyGitFailure,
  breakerAllows,
  breakerStep,
  GitCircuitBreaker,
  INITIAL_BREAKER,
  DEFAULT_GIT_BREAKER,
  type BreakerConfig,
} from '../src/execution/git-failure.js';

const CFG: BreakerConfig = { threshold: 3, baseMs: 100, maxMs: 5000 };

describe('classifyGitFailure', () => {
  it('treats a detached-HEAD base as permanent (will-never-succeed)', () => {
    expect(classifyGitFailure('fatal: HEAD is detached at 1a2b3c4')).toBe('permanent');
  });

  it('treats a worktree-add over an existing/dirty path as permanent', () => {
    expect(classifyGitFailure("fatal: '/w/run-7' already exists")).toBe('permanent');
  });

  it('treats a bad/unknown revision as permanent', () => {
    expect(classifyGitFailure("fatal: invalid reference: nope\nfatal: not a valid object name")).toBe(
      'permanent',
    );
  });

  it('treats an uncommitted-changes / would-be-overwritten tree as permanent', () => {
    expect(
      classifyGitFailure('error: Your local changes to the following files would be overwritten'),
    ).toBe('permanent');
  });

  it('treats an index.lock collision as transient (a retry may win)', () => {
    expect(
      classifyGitFailure("fatal: Unable to create '/repo/.git/index.lock': File exists"),
    ).toBe('transient');
  });

  it('defaults an unrecognised failure to transient (fail open, back off — never spin)', () => {
    expect(classifyGitFailure('some transient network hiccup')).toBe('transient');
  });

  it('is case-insensitive and tolerates surrounding noise', () => {
    expect(classifyGitFailure('git worktree add failed: FATAL: HEAD IS DETACHED at deadbeef')).toBe(
      'permanent',
    );
  });
});

describe('breakerStep (pure exponential-backoff reducer)', () => {
  it('grows the backoff window exponentially on consecutive failures', () => {
    let s = INITIAL_BREAKER;
    const r1 = breakerStep(s, 'failure', 1000, CFG);
    expect(r1.backoffMs).toBe(100);
    expect(r1.state.openUntil).toBe(1100);
    expect(r1.opened).toBe(false);
    s = r1.state;

    const r2 = breakerStep(s, 'failure', 1200, CFG);
    expect(r2.backoffMs).toBe(200);
    expect(r2.state.openUntil).toBe(1400);
    expect(r2.opened).toBe(false);
    s = r2.state;

    const r3 = breakerStep(s, 'failure', 1500, CFG);
    expect(r3.backoffMs).toBe(400);
    expect(r3.opened).toBe(true); // threshold (3) reached → escalate
  });

  it('caps the backoff at maxMs', () => {
    let s: typeof INITIAL_BREAKER = { fails: 20, openUntil: 0 };
    const r = breakerStep(s, 'failure', 0, CFG);
    expect(r.backoffMs).toBe(CFG.maxMs);
  });

  it('resets fully on success', () => {
    const s = { fails: 5, openUntil: 9999 };
    const r = breakerStep(s, 'success', 1000, CFG);
    expect(r.state).toEqual(INITIAL_BREAKER);
    expect(r.opened).toBe(false);
  });
});

describe('breakerAllows (half-open gate)', () => {
  it('blocks before openUntil and admits at/after it', () => {
    const s = { fails: 3, openUntil: 2000 };
    expect(breakerAllows(s, 1999)).toBe(false);
    expect(breakerAllows(s, 2000)).toBe(true);
    expect(breakerAllows(s, 2001)).toBe(true);
  });

  it('always admits a fresh (never-failed) context', () => {
    expect(breakerAllows(INITIAL_BREAKER, 0)).toBe(true);
  });
});

describe('GitCircuitBreaker (stateful per-context holder)', () => {
  it('backs off then opens a context after the threshold of consecutive git fast-fails', () => {
    let now = 0;
    const b = new GitCircuitBreaker(CFG, () => now);
    const key = '/repo';
    expect(b.allows(key)).toBe(true);

    const f1 = b.recordFailure(key);
    expect(f1.opened).toBe(false);
    expect(b.allows(key)).toBe(false); // in backoff window
    now = f1.backoffMs; // advance to the half-open boundary
    expect(b.allows(key)).toBe(true);

    const f2 = b.recordFailure(key);
    expect(f2.opened).toBe(false);
    now += f2.backoffMs;

    const f3 = b.recordFailure(key);
    expect(f3.opened).toBe(true); // circuit open → caller escalates the context
  });

  it('isolates contexts by key — one bad repo does not open another', () => {
    const b = new GitCircuitBreaker(CFG, () => 0);
    b.recordFailure('/a');
    b.recordFailure('/a');
    b.recordFailure('/a');
    expect(b.allows('/b')).toBe(true);
  });

  it('a success clears the context so a later transient blip starts fresh', () => {
    let now = 0;
    const b = new GitCircuitBreaker(CFG, () => now);
    const key = '/repo';
    b.recordFailure(key);
    b.recordFailure(key);
    b.recordSuccess(key);
    now = 10_000;
    // Back to a clean slate: one failure again is just the first step, not near open.
    const f = b.recordFailure(key);
    expect(f.opened).toBe(false);
    expect(f.backoffMs).toBe(CFG.baseMs);
  });

  it('ships a sane production default config', () => {
    expect(DEFAULT_GIT_BREAKER.threshold).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_GIT_BREAKER.baseMs).toBeGreaterThan(0);
    expect(DEFAULT_GIT_BREAKER.maxMs).toBeGreaterThanOrEqual(DEFAULT_GIT_BREAKER.baseMs);
  });
});
