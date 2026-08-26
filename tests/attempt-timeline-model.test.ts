import { describe, expect, it } from 'vitest';
import {
  attemptTone,
  continuationLabel,
  elapsed,
  escalationActions,
  runForAttempt,
  stateTone,
  taskLabel,
  taskLogSource,
  verifiedSha,
  verificationAttemptId,
} from '../web/src/attempt-timeline-model.js';
import type { Attempt, AttemptTask, Run } from '../web/src/types.js';

const task = (over: Partial<AttemptTask> = {}): AttemptTask => ({
  id: 1, attemptId: 1, type: 'verification', position: 3, state: 'passed', command: 'npm test', verdict: 'pass', logLocator: null, startedAt: 1_000, endedAt: 3_000, ...over,
});
const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  id: 1, taskId: 7, number: 1, state: 'failed', startedAt: 1_000, endedAt: 3_000, feedback: null, verifiedSha: null, escalationReason: null, continuation: null, tasks: [], ...over,
});
const run = (over: Partial<Run> = {}): Run => ({
  id: 1, taskId: 7, attempt: 1, state: 'running', phase: 'executing', reason: null, stopReason: null, sessionId: null, prompt: null, branch: null, baseBranch: null,
  usage: null, cost: null, review: null, reviewFeedback: null, reviewedAt: null, reviewDeadline: null, startedAt: 1_000_000, finishedAt: null, ...over,
});

describe('attempt timeline model', () => {
  it('labels ordered task types and their semantic states', () => {
    expect(taskLabel(task())).toBe('Verify · npm test');
    expect(taskLabel(task({ type: 'review', command: null }))).toBe('Review');
    expect(stateTone('running')).toBe('running');
    expect(stateTone('failed')).toBe('failed');
    expect(attemptTone('escalated')).toBe('failed');
    expect(attemptTone('cancelled')).toBe('neutral');
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
    expect(taskLogSource(task({ logLocator: 'verification_attempt:31' }))).toEqual({ kind: 'output', verificationAttemptId: 31 });
    expect(taskLogSource(task({ type: 'review', logLocator: 'verification_attempt:32' }))).toEqual({ kind: 'critic', verificationAttemptId: 32 });
    expect(taskLogSource(task({ type: 'implementation', logLocator: 'session:9' }))).toEqual({ kind: 'run' });
    expect(taskLogSource(task({ logLocator: null }))).toBeNull();
  });

  it('formats elapsed time from the attempt clock', () => {
    expect(elapsed(1_000, null, 63_000)).toBe('1m 2s');
    expect(elapsed(null, null, 63_000)).toBe('—');
  });

  it('reads the continuation decision only from recorded data', () => {
    expect(continuationLabel(null)).toBeNull();
    const base = { reason: 'context-usage' as const, contextUsage: 0.9, contextReuseThreshold: 0.7, lastActiveAt: 1, lastActiveAgeMs: 2, warmWindowMs: 3 };
    expect(continuationLabel({ path: 'new-session-condensed', ...base })).toBe('new session, condensed');
    expect(continuationLabel({ path: 'continued-session', ...base })).toBe('continued session');
  });

  it('maps an attempt to the run whose counter first reached it', () => {
    const runs = [run({ id: 10, attempt: 2 }), run({ id: 20, attempt: 3 })];
    expect(runForAttempt(runs, { number: 1 })?.id).toBe(10);
    expect(runForAttempt(runs, { number: 2 })?.id).toBe(10);
    expect(runForAttempt(runs, { number: 3 })?.id).toBe(20);
    expect(runForAttempt(runs, { number: 4 })).toBeNull();
  });

  it('offers the three escalation actions, gating candidate actions on a candidate', () => {
    expect(escalationActions({ escalated: false, candidateRef: 'refs/x', state: 'ready' })).toBeNull();
    expect(escalationActions({ escalated: true, candidateRef: 'refs/x', state: 'ready' })).toEqual({ accept: true, reject: true, close: true });
    expect(escalationActions({ escalated: true, candidateRef: null, state: 'ready' })).toEqual({ accept: false, reject: false, close: true });
    expect(escalationActions({ escalated: true, candidateRef: null, state: 'awaiting-review' })).toEqual({ accept: true, reject: true, close: true });
  });
});
