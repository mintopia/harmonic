import { describe, expect, it } from 'vitest';
import {
  attemptTone,
  continuationDetail,
  continuationLabel,
  elapsed,
  runFailureBannerLabel,
  runForAttempt,
  stateTone,
  stepLabel,
  stepLogSource,
  verifierStatusTone,
  verifiedSha,
  verificationAttemptId,
} from '../web/src/attempt-timeline-model.js';
import type { Attempt, Step, Run } from '../web/src/types.js';

const task = (over: Partial<Step> = {}): Step => ({
  id: 1, attemptId: 1, type: 'verification', position: 3, state: 'passed', command: 'npm test', verdict: 'pass', logLocator: null, startedAt: 1_000, endedAt: 3_000, ...over,
});
const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  id: 1, taskId: 7, number: 1, state: 'failed', startedAt: 1_000, endedAt: 3_000, feedback: null, verifiedSha: null, escalationReason: null, verifierStatuses: [], continuation: null, steps: [], ...over,
});
const run = (over: Partial<Run> = {}): Run => ({
  id: 1, taskId: 7, attempt: 1, state: 'running', phase: 'executing', reason: null, stopReason: null, sessionId: null, prompt: null, branch: null, baseBranch: null,
  usage: null, cost: null, startedAt: 1_000_000, finishedAt: null, ...over,
});

describe('attempt timeline model', () => {
  it('labels ordered task types and their semantic states', () => {
    expect(stepLabel(task())).toBe('Verify · npm test');
    expect(stepLabel(task({ type: 'review', command: null }))).toBe('Review');
    expect(stateTone('running')).toBe('running');
    expect(stateTone('failed')).toBe('failed');
    expect(attemptTone('escalated')).toBe('failed');
    expect(attemptTone('cancelled')).toBe('neutral');
  });

  it('uses neutral chips for verification that did not run', () => {
    expect(verifierStatusTone('passed')).toBe('passed');
    expect(verifierStatusTone('failed')).toBe('failed');
    expect(verifierStatusTone('inconclusive')).toBe('failed');
    expect(verifierStatusTone('skipped')).toBe('neutral');
    expect(verifierStatusTone('disabled')).toBe('neutral');
    expect(verifierStatusTone('unrunnable')).toBe('failed');
  });

  it('uses the latest attempt-level verification proof', () => {
    const old = attempt({ verifiedSha: 'old' });
    const current = attempt({ id: 2, number: 2, verifiedSha: 'current' });
    expect(verifiedSha([old, current])).toBe('current');
    expect(verifiedSha([old, attempt({ id: 3, number: 3 })])).toBe('old');
    expect(verifiedSha([attempt()])).toBeNull();
  });

  it('parses the verification locators written for command, review, and inconclusive tasks', () => {
    expect(verificationAttemptId('verification_attempt:31')).toBe(31);
    expect(verificationAttemptId('verification_attempt:902')).toBe(902);
    expect(verificationAttemptId('session:42')).toBeNull();
    expect(verificationAttemptId(null)).toBeNull();
  });

  it('routes each task row to the log source the viewer can fetch', () => {
    expect(stepLogSource(task({ logLocator: 'verification_attempt:31' }))).toEqual({ kind: 'output', verificationAttemptId: 31 });
    expect(stepLogSource(task({ type: 'review', logLocator: 'verification_attempt:32' }))).toEqual({ kind: 'critic', verificationAttemptId: 32 });
    expect(stepLogSource(task({ type: 'implementation', logLocator: 'session:9' }))).toEqual({ kind: 'run' });
    expect(stepLogSource(task({ logLocator: null }))).toBeNull();
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
    const runs = [run({ id: 10, attempt: 2 }), run({ id: 20, attempt: 3 })];
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
    expect(runFailureBannerLabel(run({ state: 'failed', reason: 'workspace disconnected' }), attempt())).toBe('Run failed');
    expect(runFailureBannerLabel(run({ state: 'failed', reason: 'workspace disconnected', attempt: 2 }), attempt({ number: 2, continuation: continued }))).toBe('Resume failed');
    expect(runFailureBannerLabel(run({ state: 'running', reason: 'workspace disconnected' }), attempt({ continuation: continued }))).toBeNull();
    expect(runFailureBannerLabel(run({ state: 'failed', reason: null }), attempt({ continuation: continued }))).toBeNull();
  });

});
