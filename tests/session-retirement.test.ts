import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETENTION,
  decideRetirement,
  canTransition,
  isRetentionElapsed,
  LEGAL_TRANSITIONS,
  type RetentionConfig,
} from '../src/domain/session-retirement.js';
import { SESSION_STATUSES } from '../src/db/schema.js';

/**
 * The pure Session-retirement decision (issue #148, reliability-design Unit C):
 * the deadline policy and the legal `active → idle → retiring → retired` graph,
 * tested in isolation (no db/clock/git) — the same seam as run-disposition.ts.
 */
describe('decideRetirement (issue #148)', () => {
  const now = 1_000_000;
  const cfg: RetentionConfig = { rejectContinuationMs: 5_000, retentionTtlMs: 100_000 };

  it('retires immediately on a successful land', () => {
    expect(decideRetirement('landed', now, cfg)).toEqual({ kind: 'retire', reason: 'landed' });
  });

  it('retires immediately on an operator cancel', () => {
    expect(decideRetirement('operator-cancel', now, cfg)).toEqual({
      kind: 'retire',
      reason: 'operator-disposition',
    });
  });

  it('goes idle under the retention-TTL backstop on any other ending (escalate/guardrail/crash) — an escalated ticket keeps its branch as evidence', () => {
    expect(decideRetirement('other', now, cfg)).toEqual({
      kind: 'idle',
      reason: 'retention-ttl',
      retireDeadline: now + cfg.retentionTtlMs,
    });
  });

  it('uses the default retention windows when none is passed', () => {
    expect(decideRetirement('other', 0)).toEqual({
      kind: 'idle',
      reason: 'retention-ttl',
      retireDeadline: DEFAULT_RETENTION.retentionTtlMs,
    });
    expect(decideRetirement('other', 0)).toEqual({
      kind: 'idle',
      reason: 'retention-ttl',
      retireDeadline: DEFAULT_RETENTION.retentionTtlMs,
    });
  });

  it('default reject window is shorter than the retention-TTL backstop', () => {
    expect(DEFAULT_RETENTION.rejectContinuationMs).toBeLessThan(DEFAULT_RETENTION.retentionTtlMs);
  });
});

describe('canTransition (issue #148)', () => {
  it('routes retirement through retiring — never active/idle straight to retired', () => {
    expect(canTransition('active', 'retired')).toBe(false);
    expect(canTransition('idle', 'retired')).toBe(false);
    expect(canTransition('active', 'retiring')).toBe(true);
    expect(canTransition('idle', 'retiring')).toBe(true);
    expect(canTransition('retiring', 'retired')).toBe(true);
  });

  it('allows an idle Session to reactivate for a continuation, and active to idle', () => {
    expect(canTransition('active', 'idle')).toBe(true);
    expect(canTransition('idle', 'active')).toBe(true);
  });

  it('treats retired as terminal', () => {
    for (const to of SESSION_STATUSES) {
      expect(canTransition('retired', to)).toBe(to === 'retired');
    }
  });

  it('treats a same-status transition as legal (idempotent re-application)', () => {
    for (const s of SESSION_STATUSES) expect(canTransition(s, s)).toBe(true);
  });

  it('covers every declared status in the legal-transition table', () => {
    for (const s of SESSION_STATUSES) expect(LEGAL_TRANSITIONS[s]).toBeDefined();
  });
});

describe('isRetentionElapsed (issue #148)', () => {
  it('is due only for an idle Session whose deadline has lapsed', () => {
    expect(isRetentionElapsed({ status: 'idle', retireDeadline: 100 }, 100)).toBe(true);
    expect(isRetentionElapsed({ status: 'idle', retireDeadline: 100 }, 99)).toBe(false);
  });

  it('never fires for a null deadline (retain until an explicit operator disposition)', () => {
    expect(isRetentionElapsed({ status: 'idle', retireDeadline: null }, 1e12)).toBe(false);
  });

  it('never fires for a non-idle Session', () => {
    expect(isRetentionElapsed({ status: 'active', retireDeadline: 1 }, 1e12)).toBe(false);
    expect(isRetentionElapsed({ status: 'retiring', retireDeadline: 1 }, 1e12)).toBe(false);
    expect(isRetentionElapsed({ status: 'retired', retireDeadline: 1 }, 1e12)).toBe(false);
  });
});
