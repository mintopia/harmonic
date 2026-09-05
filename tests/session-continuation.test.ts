import { describe, expect, it } from 'vitest';
import {
  planSessionContinuation,
  estimateContinuationCost,
  estimateCondensedContinuationCost,
  isAutomatedTrigger,
  sessionWarmthFacts,
  previewManualResumeContinuation,
  CONTINUATION_TRIGGERS,
  AUTOMATED_CONTINUATION_TRIGGERS,
  decideAttemptContinuation,
  type SessionWarmthFacts,
} from '../src/domain/session-continuation.js';
import type { AttemptRow, SessionRow } from '../src/db/schema.js';

describe('decideAttemptContinuation (issue #311)', () => {
  const now = 10 * 60 * 60 * 1000;
  const input = { cacheWarmSeconds: 300, contextTokens: 190_000, contextReuseTokenLimit: 200_000, lastActiveAt: now - 4 * 60 * 1000, now };

  it('continues only below the token limit and inside the configured warm window', () => {
    expect(decideAttemptContinuation(input)).toMatchObject({ path: 'continued-session', contextTokens: 190_000, warmWindowMs: 5 * 60 * 1000 });
  });

  it('starts a condensed Session at the context token-limit boundary', () => {
    expect(decideAttemptContinuation({ ...input, contextTokens: 200_000 })).toMatchObject({ path: 'new-session-condensed', reason: 'context-tokens' });
  });

  it('starts a condensed Session at the warm-window boundary', () => {
    expect(decideAttemptContinuation({ ...input, lastActiveAt: now - 5 * 60 * 1000 })).toMatchObject({ path: 'new-session-condensed', reason: 'session-cold' });
  });

  it('starts condensed when context tokens are unavailable', () => {
    expect(decideAttemptContinuation({ ...input, contextTokens: null })).toMatchObject({ path: 'new-session-condensed', reason: 'missing-context-tokens' });
  });

});

describe('planSessionContinuation (issue #147)', () => {
  const HOUR = 60 * 60 * 1000;
  const now = 10 * HOUR;
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

  describe('a manual resume surfaces the cost-gated choice', () => {
    it('offers continue-full (same Session, with a cost estimate) vs start-condensed (new Session)', () => {
      const plan = planSessionContinuation('manual-resume', warm, now);
      expect(plan.mode).toBe('offer-choice');
      if (plan.mode !== 'offer-choice') throw new Error('unreachable');
      expect(plan.continueFull.session).toBe('same');
      expect(plan.continueFull.conversation).toBe('full');
      expect(plan.startCondensed.session).toBe('new');
      expect(plan.startCondensed.conversation).toBe('condensed');
      expect(plan.continueFull.estimate).toEqual(estimateContinuationCost(warm, now));
      expect(plan.startCondensed.estimate).toEqual(estimateCondensedContinuationCost(warm, now));
      expect(plan.startCondensed.estimate.band).toBe('cold');
    });

    it('offers BOTH options even when the Session is stone cold — warmth is a cost signal, not a gate', () => {
      const cold: SessionWarmthFacts = { estimatedWarmUntil: now - HOUR, lastActiveAt: now - 3 * HOUR };
      const plan = planSessionContinuation('manual-resume', cold, now);
      if (plan.mode !== 'offer-choice') throw new Error('expected offer-choice');
      expect(plan.continueFull.estimate.band).toBe('cold');
      expect(plan.continueFull.session).toBe('same');
      expect(plan.startCondensed.session).toBe('new');
      expect(plan.startCondensed.estimate.band).toBe('warm');
    });

    it('offers BOTH options when warmth is unknown — an absent estimate never removes an option', () => {
      const unknownWarmth: SessionWarmthFacts = { estimatedWarmUntil: null, lastActiveAt: now - HOUR };
      const plan = planSessionContinuation('manual-resume', unknownWarmth, now);
      if (plan.mode !== 'offer-choice') throw new Error('expected offer-choice');
      expect(plan.continueFull.estimate.band).toBe('unknown');
      expect(plan.continueFull.session).toBe('same');
      expect(plan.startCondensed.session).toBe('new');
      expect(plan.startCondensed.estimate.band).toBe('warm');
    });
  });

  describe('estimateCondensedContinuationCost (issue #177): condensed cost, computed relative to the full path', () => {
    it('is the pricier path (cold) when the source Session is warm — full is the cache hit', () => {
      const est = estimateCondensedContinuationCost(warm, now);
      expect(est.band).toBe('cold');
      expect(est.note).toEqual(expect.any(String));
      expect(est.note.length).toBeGreaterThan(0);
    });

    it('is the cheaper path (warm) when the source Session is cold — re-primes only a summary', () => {
      const cold: SessionWarmthFacts = { estimatedWarmUntil: now - HOUR, lastActiveAt: now - 3 * HOUR };
      const est = estimateCondensedContinuationCost(cold, now);
      expect(est.band).toBe('warm');
      expect(est.note).toEqual(expect.any(String));
    });

    it('is the cheaper path (warm), never unknown, when the source has no known warm window', () => {
      const unknownWarmth: SessionWarmthFacts = { estimatedWarmUntil: null, lastActiveAt: now - HOUR };
      const est = estimateCondensedContinuationCost(unknownWarmth, now);
      expect(est.band).toBe('warm');
      expect(estimateContinuationCost(unknownWarmth, now).band).toBe('unknown');
    });
  });

  describe('trigger classification', () => {
    it('exactly automatic-retry and verify-reject are automated; manual-resume is not', () => {
      expect(isAutomatedTrigger('automatic-retry')).toBe(true);
      expect(isAutomatedTrigger('verify-reject')).toBe(true);
      expect(isAutomatedTrigger('manual-resume')).toBe(false);
    });

    it('every trigger is either automated or manual resume — no gaps', () => {
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

  it('derives warmth from a SessionRow and configured cache duration', () => {
    const row = {
      id: 7,
      harness: 'claude',
      harnessSessionId: 'abc',
      model: 'claude-opus-4-8',
      cwd: '/work/repo',
      workspaceId: 1,
      transcriptPath: null,
      mcpTemplates: '[]',
      permissionMode: 'auto',
      capabilitySnapshot: '{}',
      supportsLoadSession: true,
      adapterVersion: 'claude@1',
      status: 'active',
      lastActiveAt: now - 60_000,
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
    expect(estimateContinuationCost(sessionWarmthFacts(row, 3600), now).band).toBe('warm');
  });

  it('sessionWarmthFacts projects a SessionRow to exactly the two warmth fields', () => {
    const row = {
      id: 7,
      harness: 'claude',
      harnessSessionId: 'abc',
      model: 'claude-opus-4-8',
      cwd: '/work/repo',
      workspaceId: 1,
      transcriptPath: null,
      mcpTemplates: '[]',
      permissionMode: 'auto',
      capabilitySnapshot: '{}',
      supportsLoadSession: true,
      adapterVersion: 'claude@1',
      status: 'active',
      lastActiveAt: 123,
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
    expect(sessionWarmthFacts(row, 1)).toEqual({ estimatedWarmUntil: 1123, lastActiveAt: 123 });
  });
});

describe('previewManualResumeContinuation (issue #506)', () => {
  const HOUR = 60 * 60 * 1000;
  const now = 10 * HOUR;
  const session = (id: number, warmUntil: number): SessionRow =>
    ({
      id,
      harness: 'claude',
      harnessSessionId: `sess-${id}`,
      model: 'claude-opus-4-8',
      cwd: '/work/repo',
      workspaceId: 1,
      transcriptPath: null,
      mcpTemplates: '[]',
      permissionMode: 'auto',
      capabilitySnapshot: '{}',
      supportsLoadSession: true,
      adapterVersion: 'claude@1',
      status: 'active',
      lastActiveAt: warmUntil - HOUR,
      worktreePath: null,
      worktreeRepoDir: null,
      retireReason: null,
      retireDeadline: null,
      retiredAt: null,
      resumeIncompatibilityReason: null,
      resumeIncompatibilityDetail: null,
      createdAt: 0,
      updatedAt: 0,
    }) satisfies SessionRow;
  const run = (sessionRowId: number | null): AttemptRow => ({ sessionRowId }) as AttemptRow;

  it('returns the offer-choice plan projected against the newest Session-bound Run', () => {
    const store = new Map([[5, session(5, now + HOUR)]]);
    const plan = previewManualResumeContinuation([run(null), run(5)], (id) => store.get(id) ?? null, HOUR / 1000, now);
    expect(plan?.mode).toBe('offer-choice');
    expect(plan?.continueFull.estimate.band).toBe('warm');
    expect(plan?.startCondensed).toEqual({
      session: 'new',
      conversation: 'condensed',
      estimate: estimateCondensedContinuationCost(sessionWarmthFacts(session(5, now + HOUR), HOUR / 1000), now),
    });
  });

  it('walks back from the newest Run — the latest Session-bound Run wins', () => {
    const store = new Map([
      [1, session(1, now + HOUR)],
      [2, session(2, now - HOUR)],
    ]);
    const plan = previewManualResumeContinuation([run(1), run(2)], (id) => store.get(id) ?? null, HOUR / 1000, now);
    expect(plan?.continueFull.estimate.band).toBe('cold');
  });

  it('returns null when no Run ever bound a Session', () => {
    expect(previewManualResumeContinuation([run(null), run(null)], () => null, HOUR / 1000, now)).toBeNull();
  });

  it('returns null when the newest Session was retired and swept (lookup misses)', () => {
    expect(previewManualResumeContinuation([run(9)], () => null, HOUR / 1000, now)).toBeNull();
  });

  it('skips a swept newer Session and falls back to an older live one', () => {
    const store = new Map([[3, session(3, now + HOUR)]]);
    const plan = previewManualResumeContinuation([run(3), run(8)], (id) => store.get(id) ?? null, HOUR / 1000, now);
    expect(plan?.continueFull.estimate.band).toBe('warm');
  });
});
