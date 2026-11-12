import { describe, expect, it } from 'vitest';
import {
  attemptTone,
  continuationDetail,
  continuationLabel,
  elapsed,
  runFailureBannerLabel,
  runForAttempt,
} from '../web/src/attempt-timeline-model.js';
import type { Attempt, AttemptSummary } from '../web/src/types.js';

const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  id: 1, taskId: 7, number: 1, state: 'failed', startedAt: 1_000, endedAt: 3_000, feedback: null, escalationReason: null, workingDir: null, harness: null, model: null, classifier: null, routing: null, continuation: null, stepRuns: [], ...over,
});
const run = (over: Partial<AttemptSummary> = {}): AttemptSummary => ({
  pullRequestUrl: null, id: 1, taskId: 7, number: 1, state: 'running', reason: null, stopReason: null, sessionId: null, prompt: null, branch: null, baseBranch: null,
  usage: null, cost: null, startedAt: 1_000_000, finishedAt: null, ...over,
});

describe('attempt timeline model', () => {
  it('tones an attempt by state', () => {
    expect(attemptTone('escalated')).toBe('failed');
    expect(attemptTone('cancelled')).toBe('neutral');
  });

  it('formats elapsed time from the attempt clock', () => {
    expect(elapsed(1_000, null, 63_000)).toBe('1m 2s');
    expect(elapsed(null, null, 63_000)).toBe('—');
  });

  it('reads the continuation decision only from recorded data', () => {
    expect(continuationLabel(null)).toBeNull();
    const base = { reason: 'context-tokens' as const, contextTokens: 180_000, contextReuseTokenLimit: 200_000, lastActiveAt: 1, lastActiveAgeMs: 2, warmWindowMs: 3 };
    expect(continuationLabel({ path: 'new-session-condensed', ...base })).toBe('new session, condensed');
    expect(continuationLabel({ path: 'continued-session', ...base })).toBe('continued session');
    expect(continuationDetail({ path: 'continued-session', ...base, lastActiveAgeMs: 2_500, warmWindowMs: 30_000 })).toBe('context 180k/200k · active 2.5s/30s');
    expect(continuationDetail({ path: 'continued-session', ...base, contextTokens: null, warmWindowMs: null })).toBe('context unknown/200k · active 2ms/unknown');
    expect(continuationDetail(null)).toBeNull();
  });

  it('maps an attempt to the run whose counter first reached it', () => {
    const runs = [run({ id: 10, number: 2 }), run({ id: 20, number: 3 })];
    expect(runForAttempt(runs, { number: 1 })?.id).toBe(10);
    expect(runForAttempt(runs, { number: 2 })?.id).toBe(10);
    expect(runForAttempt(runs, { number: 3 })?.id).toBe(20);
    expect(runForAttempt(runs, { number: 4 })).toBeNull();
  });

  it('marks failed resumed attempts distinctly from original failures', () => {
    const continued = {
      path: 'continued-session' as const,
      reason: 'continued-within-limits' as const,
      contextTokens: 40_000,
      contextReuseTokenLimit: 200_000,
      lastActiveAt: 1,
      lastActiveAgeMs: 2_000,
      warmWindowMs: 30_000,
    };
    expect(runFailureBannerLabel(run({ state: 'failed', reason: 'workspace disconnected' }), attempt())).toBe('Attempt failed');
    expect(runFailureBannerLabel(run({ state: 'failed', reason: 'workspace disconnected', number: 2 }), attempt({ number: 2, continuation: continued }))).toBe('Resume failed');
    expect(runFailureBannerLabel(run({ state: 'running', reason: 'workspace disconnected' }), attempt({ continuation: continued }))).toBeNull();
    expect(runFailureBannerLabel(run({ state: 'failed', reason: null }), attempt({ continuation: continued }))).toBeNull();
  });

});
