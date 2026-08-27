import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LEASE_TTL,
  leaseTtlMsForPhase,
  leaseExpiryFor,
  isLeaseLapsed,
} from '../src/domain/lease-ttl.js';

/**
 * The Work Context lease TTL budgets (issue #122): pure phase→budget mapping,
 * no database, no clock, no I/O — mirrors `guardrail-budget.ts`'s pure-seam
 * style so the TTL/lapse contract can be exhaustively unit-tested.
 */
describe('lease-ttl (issue #122)', () => {
  describe('leaseTtlMsForPhase', () => {

    it('an execution phase gets the execution budget', () => {
      expect(leaseTtlMsForPhase('executing')).toBe(DEFAULT_LEASE_TTL.executionMs);
      expect(leaseTtlMsForPhase('validating')).toBe(DEFAULT_LEASE_TTL.executionMs);
      expect(leaseTtlMsForPhase('verifying')).toBe(DEFAULT_LEASE_TTL.executionMs);
      expect(leaseTtlMsForPhase('merging')).toBe(DEFAULT_LEASE_TTL.executionMs);
    });

    it('the pre-phase-machine literal "running" gets the execution budget', () => {
      expect(leaseTtlMsForPhase('running')).toBe(DEFAULT_LEASE_TTL.executionMs);
    });

    it('null/undefined get the execution budget', () => {
      expect(leaseTtlMsForPhase(null)).toBe(DEFAULT_LEASE_TTL.executionMs);
      expect(leaseTtlMsForPhase(undefined)).toBe(DEFAULT_LEASE_TTL.executionMs);
    });

    it('respects a custom LeaseTtl override, for every phase (no phase parks a lease awaiting a human)', () => {
      const ttl = { executionMs: 111 };
      expect(leaseTtlMsForPhase('executing', ttl)).toBe(111);
      expect(leaseTtlMsForPhase('merging', ttl)).toBe(111);
      expect(leaseTtlMsForPhase('terminal', ttl)).toBe(111);
    });
  });

  describe('leaseExpiryFor', () => {
    it('is now + the phase budget', () => {
      const now = 1_000_000;
      expect(leaseExpiryFor('executing', now)).toBe(now + DEFAULT_LEASE_TTL.executionMs);
      expect(leaseExpiryFor('merging', now)).toBe(now + DEFAULT_LEASE_TTL.executionMs);
    });

    it('respects a custom LeaseTtl override', () => {
      const now = 1_000_000;
      const ttl = { executionMs: 111 };
      expect(leaseExpiryFor('executing', now, ttl)).toBe(now + 111);
    });
  });

  describe('isLeaseLapsed', () => {
    it('held + past expiry -> true', () => {
      expect(isLeaseLapsed({ state: 'held', expiry: 100 }, 200)).toBe(true);
    });

    it('held + expiry exactly now -> true (boundary trips)', () => {
      expect(isLeaseLapsed({ state: 'held', expiry: 200 }, 200)).toBe(true);
    });

    it('held + future expiry -> false', () => {
      expect(isLeaseLapsed({ state: 'held', expiry: 300 }, 200)).toBe(false);
    });

    it('held + null expiry -> false (never heartbeated; boot reconciliation is the backstop)', () => {
      expect(isLeaseLapsed({ state: 'held', expiry: null }, 200)).toBe(false);
    });

    it('suspect + past expiry -> false (already reconciled, not re-lapsed)', () => {
      expect(isLeaseLapsed({ state: 'suspect', expiry: 100 }, 200)).toBe(false);
    });
  });
});
