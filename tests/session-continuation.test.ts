import { describe, expect, it } from 'vitest';
import {
  planSessionContinuation,
  estimateContinuationCost,
  isAutomatedTrigger,
  CONTINUATION_TRIGGERS,
  AUTOMATED_CONTINUATION_TRIGGERS,
  type SessionWarmthFacts,
} from '../src/domain/session-continuation.js';
import type { SessionRow } from '../src/db/schema.js';

/**
 * The pure retry/reject continuation decision (issue #147, reliability-design
 * Unit C): `(trigger, Session warmth, now) → silent-continue | offer-choice`,
 * tested in isolation (no db/clock/harness). Automated triggers reuse the warm
 * Session silently; a human rejection surfaces a cost-gated choice — and warmth
 * is only ever a cost signal, never a gate. Same seam shape as session-resume.ts.
 */
describe('planSessionContinuation (issue #147)', () => {
  const HOUR = 60 * 60 * 1000;
  const now = 10 * HOUR;
  // A comfortably-warm Session: cache lapses an hour from now.
  const warm: SessionWarmthFacts = { estimatedWarmUntil: now + HOUR, lastActiveAt: now - 5 * 60 * 1000 };

  describe('automated triggers reuse the warm Session silently', () => {
    for (const trigger of AUTOMATED_CONTINUATION_TRIGGERS) {
      it(`${trigger} → silent-continue on the same Session`, () => {
        expect(planSessionContinuation(trigger, warm, now)).toEqual({
          mode: 'silent-continue',
          trigger,
          sameSession: true,
        });
      });
    }
  });

  describe('a human rejection surfaces the cost-gated choice', () => {
    it('offers continue-full (same Session, with a cost estimate) vs start-condensed (new Session)', () => {
      const plan = planSessionContinuation('human-reject', warm, now);
      expect(plan.mode).toBe('offer-choice');
      if (plan.mode !== 'offer-choice') throw new Error('unreachable');
      expect(plan.continueFull.session).toBe('same');
      expect(plan.continueFull.conversation).toBe('full');
      expect(plan.startCondensed.session).toBe('new');
      expect(plan.startCondensed.conversation).toBe('condensed');
      // The estimate is attached to the full option (the one whose cost varies).
      expect(plan.continueFull.estimate).toEqual(estimateContinuationCost(warm, now));
    });

    it('offers BOTH options even when the Session is stone cold — warmth is a cost signal, not a gate', () => {
      const cold: SessionWarmthFacts = { estimatedWarmUntil: now - HOUR, lastActiveAt: now - 3 * HOUR };
      const plan = planSessionContinuation('human-reject', cold, now);
      if (plan.mode !== 'offer-choice') throw new Error('expected offer-choice');
      // The full-continuation option is still present, just with a cold-cost estimate.
      expect(plan.continueFull.estimate.band).toBe('cold');
      expect(plan.continueFull.session).toBe('same');
      expect(plan.startCondensed.session).toBe('new');
    });

    it('offers BOTH options when warmth is unknown — an absent estimate never removes an option', () => {
      const unknownWarmth: SessionWarmthFacts = { estimatedWarmUntil: null, lastActiveAt: now - HOUR };
      const plan = planSessionContinuation('human-reject', unknownWarmth, now);
      if (plan.mode !== 'offer-choice') throw new Error('expected offer-choice');
      expect(plan.continueFull.estimate.band).toBe('unknown');
      expect(plan.continueFull.session).toBe('same');
      expect(plan.startCondensed.session).toBe('new');
    });
  });

  describe('trigger classification', () => {
    it('exactly automatic-retry and verify-reject are automated; human-reject is not', () => {
      expect(isAutomatedTrigger('automatic-retry')).toBe(true);
      expect(isAutomatedTrigger('verify-reject')).toBe(true);
      expect(isAutomatedTrigger('human-reject')).toBe(false);
    });

    it('every trigger is either automated or the human reject — no gaps', () => {
      for (const trigger of CONTINUATION_TRIGGERS) {
        const plan = planSessionContinuation(trigger, warm, now);
        expect(plan.mode).toBe(isAutomatedTrigger(trigger) ? 'silent-continue' : 'offer-choice');
      }
    });
  });
});

describe('estimateContinuationCost (issue #147 AC4)', () => {
  const HOUR = 60 * 60 * 1000;
  const now = 10 * HOUR;

  it('reports warm when now is within the estimated warm window', () => {
    const est = estimateContinuationCost({ estimatedWarmUntil: now + 20 * 60 * 1000, lastActiveAt: now - 60_000 }, now);
    expect(est).toMatchObject({ band: 'warm', warm: true, warmthKnown: true });
    expect(est.msUntilCold).toBe(20 * 60 * 1000);
    expect(est.msSinceActive).toBe(60_000);
    expect(est.note).toContain('warm');
  });

  it('reports cold once the estimated warm window has lapsed (negative msUntilCold)', () => {
    const est = estimateContinuationCost({ estimatedWarmUntil: now - 10 * 60 * 1000, lastActiveAt: now - HOUR }, now);
    expect(est).toMatchObject({ band: 'cold', warm: false, warmthKnown: true });
    expect(est.msUntilCold).toBe(-10 * 60 * 1000);
  });

  it('treats the exact warm-window boundary as still warm', () => {
    const est = estimateContinuationCost({ estimatedWarmUntil: now, lastActiveAt: now - 60_000 }, now);
    expect(est.band).toBe('warm');
    expect(est.warm).toBe(true);
    expect(est.msUntilCold).toBe(0);
  });

  it('reports unknown (not a fabricated cold) when the harness has no warm window', () => {
    const est = estimateContinuationCost({ estimatedWarmUntil: null, lastActiveAt: now - HOUR }, now);
    expect(est).toMatchObject({ band: 'unknown', warm: false, warmthKnown: false, estimatedWarmUntil: null, msUntilCold: null });
    expect(est.msSinceActive).toBe(HOUR);
    expect(est.note).toContain('cannot be estimated');
  });

  it('reads warmth straight off a SessionRow (structurally assignable to SessionWarmthFacts)', () => {
    const row = {
      id: 7,
      harness: 'claude',
      harnessSessionId: 'abc',
      model: 'claude-opus-4-8',
      cwd: '/work/repo',
      workspaceId: 1,
      mcpTemplates: '[]',
      permissionMode: 'auto',
      capabilitySnapshot: '{}',
      supportsLoadSession: true,
      adapterVersion: 'claude@1',
      status: 'active',
      lastActiveAt: now - 60_000,
      estimatedWarmUntil: now + HOUR,
      worktreePath: null,
      worktreeRepoDir: null,
      retireReason: null,
      retireDeadline: null,
      retiredAt: null,
      resumeIncompatibilityReason: null,
      resumeIncompatibilityDetail: null,
      createdAt: 0,
      updatedAt: 0,
    } satisfies SessionRow;
    expect(estimateContinuationCost(row, now).band).toBe('warm');
  });
});
