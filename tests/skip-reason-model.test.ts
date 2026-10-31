import { describe, expect, it } from 'vitest';
import { parseSkipReasonTaskRef, parseTargetWait } from '../web/src/skip-reason-model.js';

describe('parseSkipReasonTaskRef', () => {
  it('extracts the holder id from the canonical server format', () => {
    expect(parseSkipReasonTaskRef('Work Context held by task 12 (running)')).toBe(12);
  });

  it('returns null for null input', () => {
    expect(parseSkipReasonTaskRef(null)).toBeNull();
  });

  it('returns null for a string with no task reference', () => {
    expect(parseSkipReasonTaskRef('Blocked on dependencies')).toBeNull();
  });

  it('returns null for a differently-worded reason with no id', () => {
    expect(parseSkipReasonTaskRef('Work Context held by another run')).toBeNull();
  });

  it.each([
    'At capacity',
    'Integration branch missing',
    'Git backoff',
    'Workspace disabled',
    'HITL',
  ])('leaves non-lease scheduler reasons as plain text', (reason) => {
    expect(parseSkipReasonTaskRef(reason)).toBeNull();
  });
});

describe('parseTargetWait', () => {
  it('reads the target and the disabled flag, and ignores other reasons', () => {
    expect(parseTargetWait('waiting for k8s-prod')).toEqual({ target: 'k8s-prod', disabled: false });
    expect(parseTargetWait('waiting for k8s-staging (disabled)')).toEqual({ target: 'k8s-staging', disabled: true });
    expect(parseTargetWait('Work Context held by task 12 (working)')).toBeNull();
    expect(parseTargetWait(null)).toBeNull();
  });
});
