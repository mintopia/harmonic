import { describe, expect, it } from 'vitest';
import {
  TURN_CANCEL_PRECEDENCE,
  isMutating,
  planTurnQueue,
  type SessionWorld,
  type TurnItem,
  type TurnStatus,
} from '../src/domain/turn-queue.js';

/** A minimal `TurnItem` builder; every field can be overridden per-test. */
const item = (overrides: Partial<TurnItem> & { id: number; seq: number }): TurnItem => ({
  status: 'queued',
  purpose: 'continue',
  runId: 1,
  ...overrides,
});

/** A minimal `SessionWorld` builder; every field can be overridden per-test. */
const world = (overrides: Partial<SessionWorld> = {}): SessionWorld => ({
  runId: 1,
  phase: 'executing',
  generation: 0,
  executionClosed: false,
  ...overrides,
});

describe('planTurnQueue (issue #116)', () => {
  describe('AC1: single-flight', () => {
    it('dispatches the lower-seq pending item when the Session is clean and idle', () => {
      const a = item({ id: 1, seq: 2 });
      const b = item({ id: 2, seq: 1 });
      const plan = planTurnQueue([a, b], world());
      expect(plan.dispatch).toBe(b);
      expect(plan.cancel).toEqual([]);
    });

    it('never dispatches while another item is already in_flight', () => {
      const inFlight = item({ id: 1, seq: 1, status: 'in_flight' });
      const queued = item({ id: 2, seq: 2, status: 'queued' });
      const plan = planTurnQueue([inFlight, queued], world());
      expect(plan.dispatch).toBeNull();
      expect(plan.cancel).toEqual([]); // queued item is still admissible, just waiting
    });
  });

  describe('AC2: precondition cancel', () => {
    it('cancels wrong-phase without dispatching it', () => {
      const bad = item({ id: 1, seq: 1, expectedPhase: 'validating' });
      const plan = planTurnQueue([bad], world({ phase: 'executing' }));
      expect(plan.dispatch).toBeNull();
      expect(plan.cancel).toEqual([{ item: bad, reason: 'wrong-phase' }]);
    });

    it('cancels stale-generation without dispatching it', () => {
      const bad = item({ id: 1, seq: 1, expectedGeneration: 3 });
      const plan = planTurnQueue([bad], world({ generation: 4 }));
      expect(plan.dispatch).toBeNull();
      expect(plan.cancel).toEqual([{ item: bad, reason: 'stale-generation' }]);
    });

    it('cancels changed-oid without dispatching it', () => {
      const bad = item({ id: 1, seq: 1, expectedWorkspaceOID: 'oid-a' });
      const plan = planTurnQueue([bad], world({ workspaceOID: 'oid-b' }));
      expect(plan.dispatch).toBeNull();
      expect(plan.cancel).toEqual([{ item: bad, reason: 'changed-oid' }]);
    });

    it('cancels changed-fingerprint without dispatching it', () => {
      const bad = item({ id: 1, seq: 1, expectedFingerprint: 'fp-a' });
      const plan = planTurnQueue([bad], world({ fingerprint: 'fp-b' }));
      expect(plan.dispatch).toBeNull();
      expect(plan.cancel).toEqual([{ item: bad, reason: 'changed-fingerprint' }]);
    });

    it('cancels wrong-run without dispatching it', () => {
      const bad = item({ id: 1, seq: 1, runId: 99 });
      const plan = planTurnQueue([bad], world({ runId: 1 }));
      expect(plan.dispatch).toBeNull();
      expect(plan.cancel).toEqual([{ item: bad, reason: 'wrong-run' }]);
    });

    it('when several mismatches hold at once, the precedence-first reason wins', () => {
      // wrong-run AND wrong-phase AND stale-generation all hold; wrong-run outranks the rest.
      const bad = item({
        id: 1,
        seq: 1,
        runId: 99,
        expectedPhase: 'validating',
        expectedGeneration: 3,
      });
      const plan = planTurnQueue([bad], world({ runId: 1, phase: 'executing', generation: 0 }));
      expect(plan.cancel).toEqual([{ item: bad, reason: 'wrong-run' }]);
    });

    it('matches the reliability-design §0.4 cancel-reason precedence exactly (locked ordering)', () => {
      expect(TURN_CANCEL_PRECEDENCE).toEqual([
        'execution-closed',
        'wrong-run',
        'wrong-phase',
        'stale-generation',
        'changed-oid',
        'changed-fingerprint',
      ]);
    });

    it('execution-closed outranks every other reason, even when all of them hold simultaneously', () => {
      const bad = item({
        id: 1,
        seq: 1,
        runId: 99,
        expectedPhase: 'validating',
        expectedGeneration: 3,
        expectedWorkspaceOID: 'oid-a',
        expectedFingerprint: 'fp-a',
      });
      const plan = planTurnQueue(
        [bad],
        world({
          runId: 1,
          phase: 'executing',
          generation: 0,
          workspaceOID: 'oid-b',
          fingerprint: 'fp-b',
          executionClosed: true,
        }),
      );
      expect(plan.cancel).toEqual([{ item: bad, reason: 'execution-closed' }]);
      expect(plan.dispatch).toBeNull();
    });
  });

  describe('AC3: execution-closed cancels every pending turn', () => {
    it('cancels queued and claimed turns alike, with reason execution-closed, even when they would otherwise pass', () => {
      const queued = item({ id: 1, seq: 1, status: 'queued' });
      const claimed = item({ id: 2, seq: 2, status: 'claimed' });
      const plan = planTurnQueue([queued, claimed], world({ executionClosed: true }));
      expect(plan.dispatch).toBeNull();
      expect(plan.cancel).toEqual([
        { item: queued, reason: 'execution-closed' },
        { item: claimed, reason: 'execution-closed' },
      ]);
    });
  });

  describe('AC4: ADR-0018 — a live turn holds the Session until the next turn boundary', () => {
    it('a steer queued while another turn is in_flight is not dispatched', () => {
      const inFlight = item({ id: 1, seq: 1, status: 'in_flight', purpose: 'continue' });
      const steer = item({ id: 2, seq: 2, status: 'queued', purpose: 'steer' });
      const plan = planTurnQueue([inFlight, steer], world());
      expect(plan.dispatch).toBeNull();
    });

    it('once the in_flight turn settles to done, a re-plan dispatches the steer', () => {
      const settled = item({ id: 1, seq: 1, status: 'done', purpose: 'continue' });
      const steer = item({ id: 2, seq: 2, status: 'queued', purpose: 'steer' });
      const plan = planTurnQueue([settled, steer], world());
      expect(plan.dispatch).toBe(steer);
      expect(plan.cancel).toEqual([]);
    });
  });

  describe('AC5: mutating turns (self-heal / re-merge) bind workspace preconditions', () => {
    it('isMutating is true only for self-heal and re-merge', () => {
      expect(isMutating('self-heal')).toBe(true);
      expect(isMutating('re-merge')).toBe(true);
      expect(isMutating('initial')).toBe(false);
      expect(isMutating('continue')).toBe(false);
      expect(isMutating('steer')).toBe(false);
      expect(isMutating('crash-recovery')).toBe(false);
    });

    it('cancels a self-heal whose expected workspace OID no longer matches', () => {
      const heal = item({
        id: 1,
        seq: 1,
        purpose: 'self-heal',
        expectedWorkspaceOID: 'oid-a',
        expectedFingerprint: 'fp-a',
      });
      const plan = planTurnQueue([heal], world({ workspaceOID: 'oid-b', fingerprint: 'fp-a' }));
      expect(plan.cancel).toEqual([{ item: heal, reason: 'changed-oid' }]);
      expect(plan.dispatch).toBeNull();
    });

    it('cancels a re-merge whose OID matches but fingerprint has since changed', () => {
      const remerge = item({
        id: 1,
        seq: 1,
        purpose: 're-merge',
        expectedWorkspaceOID: 'oid-a',
        expectedFingerprint: 'fp-a',
      });
      const plan = planTurnQueue([remerge], world({ workspaceOID: 'oid-a', fingerprint: 'fp-b' }));
      expect(plan.cancel).toEqual([{ item: remerge, reason: 'changed-fingerprint' }]);
      expect(plan.dispatch).toBeNull();
    });

    it('dispatches a mutating turn whose OID, fingerprint, phase, and generation all still hold', () => {
      const heal = item({
        id: 1,
        seq: 1,
        purpose: 'self-heal',
        expectedPhase: 'executing',
        expectedGeneration: 2,
        expectedWorkspaceOID: 'oid-a',
        expectedFingerprint: 'fp-a',
      });
      const plan = planTurnQueue(
        [heal],
        world({ phase: 'executing', generation: 2, workspaceOID: 'oid-a', fingerprint: 'fp-a' }),
      );
      expect(plan.dispatch).toBe(heal);
      expect(plan.cancel).toEqual([]);
    });
  });

  describe('purity / order-independence', () => {
    it('ignores terminal items (done, failed, cancelled) — neither dispatched nor re-cancelled', () => {
      const done = item({ id: 1, seq: 1, status: 'done' as TurnStatus });
      const failed = item({ id: 2, seq: 2, status: 'failed' as TurnStatus });
      const cancelled = item({ id: 3, seq: 3, status: 'cancelled' as TurnStatus });
      const plan = planTurnQueue([done, failed, cancelled], world());
      expect(plan.dispatch).toBeNull();
      expect(plan.cancel).toEqual([]);
    });

    it('empty input yields an empty, idle plan', () => {
      expect(planTurnQueue([], world())).toEqual({ dispatch: null, cancel: [] });
    });

    it('input order does not change the plan', () => {
      const a = item({ id: 1, seq: 3 });
      const b = item({ id: 2, seq: 1, expectedPhase: 'validating' }); // will be cancelled
      const c = item({ id: 3, seq: 2 });
      const w = world({ phase: 'executing' });

      const forward = planTurnQueue([a, b, c], w);
      const reversed = planTurnQueue([c, b, a], w);
      expect(forward).toEqual(reversed);
      expect(forward.dispatch).toBe(c); // smallest surviving seq
      expect(forward.cancel).toEqual([{ item: b, reason: 'wrong-phase' }]);
    });
  });
});
