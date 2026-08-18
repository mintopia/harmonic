import { describe, expect, it } from 'vitest';
import { leaseActions, type LeaseState } from '../web/src/lease-actions-model.js';

const LEASE_STATES: LeaseState[] = ['held', 'suspect'];

describe('leaseActions', () => {
  it('offers supersede then unlock for a held lease', () => {
    expect(leaseActions('held')).toEqual(['supersede', 'unlock']);
  });

  it('offers supersede then unlock for a suspect lease too', () => {
    expect(leaseActions('suspect')).toEqual(['supersede', 'unlock']);
  });

  it('covers every lease state (no state falls through to undefined)', () => {
    for (const state of LEASE_STATES) {
      expect(Array.isArray(leaseActions(state))).toBe(true);
    }
  });

  it('returns [] for an unknown state instead of crashing (server version skew)', () => {
    expect(leaseActions('some-future-state' as never)).toEqual([]);
  });
});
