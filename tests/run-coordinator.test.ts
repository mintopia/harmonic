import { describe, expect, it } from 'vitest';
import { projectSettle, type CoordinatorFact, type SettleProjection } from '../src/domain/run-coordinator.js';
import type { Disposition } from '../src/domain/run-disposition.js';

/** A fact at `seq` of `type` carrying the projection its signal intended. */
const fact = (seq: number, type: Disposition, projection: SettleProjection): CoordinatorFact => ({
  seq,
  type,
  projection,
});

// The concrete projections the live settle path records for each signal.
const AGENT_FINISH_NATIVE: SettleProjection = { runState: 'completed', taskAction: 'awaiting-review', reason: null };
const AGENT_FINISH_MIRRORED: SettleProjection = { runState: 'completed', taskAction: 'completed', reason: null };
const ESCALATED: SettleProjection = { runState: 'failed', taskAction: 'escalate', reason: 'escalated to human: blocked' };
const OPERATOR_CANCEL: SettleProjection = { runState: 'cancelled', taskAction: 'none', reason: null };
const FAILED: SettleProjection = { runState: 'failed', taskAction: 'failed', reason: 'boom' };

describe('projectSettle (issue #113 — settle coordinator projection)', () => {
  it('returns null when the Run has no facts (has not ended)', () => {
    expect(projectSettle([], 10)).toBeNull();
  });

  it('projects the sole ending signal verbatim', () => {
    expect(projectSettle([fact(1, 'agent-finish/unresolved', AGENT_FINISH_NATIVE)], 1)).toEqual(AGENT_FINISH_NATIVE);
  });

  it('a cancel arriving close to an agent-finish resolves to cancelled (operator-cancel > agent-finish)', () => {
    // The agent finished its turn (Run row would settle completed, first-writer),
    // then an operator-cancel lands. Precedence — not write order — decides.
    const facts = [
      fact(1, 'agent-finish/unresolved', AGENT_FINISH_NATIVE),
      fact(2, 'operator-cancel', OPERATOR_CANCEL),
    ];
    expect(projectSettle(facts, 2)).toEqual(OPERATOR_CANCEL);
    expect(projectSettle(facts, 2)!.runState).toBe('cancelled');
  });

  it('resolves by precedence regardless of append order (cancel appended first still wins)', () => {
    const facts = [
      fact(1, 'operator-cancel', OPERATOR_CANCEL),
      fact(2, 'agent-finish/unresolved', AGENT_FINISH_NATIVE),
    ];
    expect(projectSettle(facts, 2)).toEqual(OPERATOR_CANCEL);
  });

  it('escalate outranks a racing agent-finish', () => {
    const facts = [
      fact(1, 'agent-finish/unresolved', AGENT_FINISH_MIRRORED),
      fact(2, 'escalate', ESCALATED),
    ];
    expect(projectSettle(facts, 2)).toEqual(ESCALATED);
  });

  it('agent-finish outranks a bare process death / late failure', () => {
    const facts = [
      fact(1, 'agent-finish/unresolved', AGENT_FINISH_MIRRORED),
      fact(2, 'failed', FAILED),
    ];
    expect(projectSettle(facts, 2)).toEqual(AGENT_FINISH_MIRRORED);
  });

  it('escalate outranks a bare failure even though both settle the Run failed (the taskAction differs)', () => {
    // Both land runState 'failed', so a coordinator keying idempotency on the
    // Run state alone would wrongly drop the escalate; keying on the disposition
    // keeps the Task-level override (failed → escalate).
    const facts = [fact(1, 'failed', FAILED), fact(2, 'escalate', ESCALATED)];
    const winner = projectSettle(facts, 2)!;
    expect(winner).toEqual(ESCALATED);
    expect(winner.runState).toBe(FAILED.runState); // same Run state…
    expect(winner.taskAction).not.toBe(FAILED.taskAction); // …different Task action
  });

  it('a late higher-precedence fact (after the cutoff) is audit-only and does not change the projection', () => {
    const before = [fact(1, 'agent-finish/unresolved', AGENT_FINISH_NATIVE)];
    expect(projectSettle(before, 1)).toEqual(AGENT_FINISH_NATIVE);
    const withLateCancel = [...before, fact(2, 'operator-cancel', OPERATOR_CANCEL)];
    expect(projectSettle(withLateCancel, 1)).toEqual(AGENT_FINISH_NATIVE);
  });

  it('duplicate facts of the winning kind collapse to the earliest one deterministically', () => {
    const first: SettleProjection = { runState: 'completed', taskAction: 'awaiting-review', reason: 'first' };
    const second: SettleProjection = { runState: 'completed', taskAction: 'awaiting-review', reason: 'second' };
    const facts = [fact(1, 'agent-finish/unresolved', first), fact(2, 'agent-finish/unresolved', second)];
    expect(projectSettle(facts, 2)).toEqual(first);
    // Order-independent: still the earliest seq, not the first array element.
    expect(projectSettle([...facts].reverse(), 2)).toEqual(first);
  });

  it('two guardrail trips both fire → the earliest fact is the primary reason (issue #131)', () => {
    // The hard tool-timeout and the wall-clock budget can both fire close
    // together; each appends a `guardrail-trip` fact carrying its own reason
    // (reliability-design Unit A: "precedence picks the primary"). They share
    // the disposition kind, so `computeDisposition` ranks them equally and this
    // earliest-seq rule is exactly the "coordinator precedence selects the
    // primary reason" contract — no dimension-priority table needed.
    const TOOL_TIMEOUT: SettleProjection = {
      runState: 'failed',
      taskAction: 'escalate',
      reason: 'tool unresponsive: 20m',
    };
    const WALL_CLOCK: SettleProjection = { runState: 'failed', taskAction: 'escalate', reason: 'budget: 60m' };
    const facts = [fact(1, 'guardrail-trip', TOOL_TIMEOUT), fact(2, 'guardrail-trip', WALL_CLOCK)];
    expect(projectSettle(facts, 2)).toEqual(TOOL_TIMEOUT);
    // Order-independent: still the earliest-seq (primary) reason, not the array head.
    expect(projectSettle([...facts].reverse(), 2)).toEqual(TOOL_TIMEOUT);
  });

  it('is idempotent — recomputing over the same facts + cutoff yields the same projection', () => {
    const facts = [
      fact(1, 'failed', FAILED),
      fact(2, 'escalate', ESCALATED),
      fact(3, 'process-death', { runState: 'failed', taskAction: 'failed', reason: 'interrupted' }),
    ];
    const once = projectSettle(facts, 3);
    expect(projectSettle(facts, 3)).toEqual(once);
    expect(once).toEqual(ESCALATED);
  });
});
