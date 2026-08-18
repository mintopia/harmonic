import { describe, expect, it } from 'vitest';
import { phaseTimelineFromEvents, RUN_PHASES } from '../web/src/phase-timeline-model.js';
import type { RunEvent } from '../web/src/types.js';

const evt = (id: number, payload: any, ts = id): RunEvent => ({
  id,
  runId: 1,
  seq: id,
  ts,
  type: 'lifecycle',
  payload,
});

const phaseEvt = (id: number, phase: string, ts = id): RunEvent => evt(id, { event: 'phase', phase }, ts);

describe('phaseTimelineFromEvents', () => {
  it('returns every RUN_PHASES entry as pending when there are no events and no current phase', () => {
    const steps = phaseTimelineFromEvents([], null, 'running');
    expect(steps).toEqual(RUN_PHASES.map((phase) => ({ phase, status: 'pending', at: null })));
  });

  it('marks the current phase current (with no timestamp yet) when no phase events have landed', () => {
    const steps = phaseTimelineFromEvents([], 'executing', 'running');
    expect(steps.find((s) => s.phase === 'executing')).toEqual({
      phase: 'executing',
      status: 'current',
      at: null,
    });
    expect(steps.filter((s) => s.phase !== 'executing').every((s) => s.status === 'pending')).toBe(true);
  });

  it('marks entered phases done, the current phase current, and the rest pending for a run mid-verifying', () => {
    const events = [phaseEvt(1, 'executing', 10), phaseEvt(2, 'validating', 20), phaseEvt(3, 'verifying', 30)];
    const steps = phaseTimelineFromEvents(events, 'verifying', 'running');
    expect(steps).toEqual([
      { phase: 'executing', status: 'done', at: 10 },
      { phase: 'validating', status: 'done', at: 20 },
      { phase: 'verifying', status: 'current', at: 30 },
      { phase: 'review', status: 'pending', at: null },
      { phase: 'landing', status: 'pending', at: null },
      { phase: 'terminal', status: 'pending', at: null },
    ]);
  });

  it('marks every reached phase done and none current once the run has settled', () => {
    const events = [
      phaseEvt(1, 'executing', 10),
      phaseEvt(2, 'validating', 20),
      phaseEvt(3, 'verifying', 30),
      phaseEvt(4, 'landing', 40),
      phaseEvt(5, 'terminal', 50),
    ];
    const steps = phaseTimelineFromEvents(events, 'terminal', 'completed');
    expect(steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'pending', 'done', 'done']);
    expect(steps.every((s) => s.status !== 'current')).toBe(true);
    expect(steps.find((s) => s.phase === 'terminal')).toEqual({ phase: 'terminal', status: 'done', at: 50 });
  });

  it('a failed/cancelled run also settles its reached phases to done with no current', () => {
    const events = [phaseEvt(1, 'executing', 10)];
    const steps = phaseTimelineFromEvents(events, 'executing', 'failed');
    expect(steps.find((s) => s.phase === 'executing')).toEqual({ phase: 'executing', status: 'done', at: 10 });
  });

  it('keeps the first occurrence timestamp and ignores a later duplicate of the same phase', () => {
    const events = [phaseEvt(1, 'executing', 100), phaseEvt(2, 'executing', 999)];
    const steps = phaseTimelineFromEvents(events, 'executing', 'running');
    expect(steps.find((s) => s.phase === 'executing')).toEqual({ phase: 'executing', status: 'current', at: 100 });
  });

  it('records an out-of-order phase event by its own timestamp, independent of array position', () => {
    // 'verifying' arrives in the array before 'executing' but with an earlier ts —
    // the array position (occurrence order), not the ts value, decides "first".
    const events = [phaseEvt(1, 'verifying', 50), phaseEvt(2, 'executing', 100)];
    const steps = phaseTimelineFromEvents(events, 'verifying', 'running');
    expect(steps.find((s) => s.phase === 'verifying')).toEqual({ phase: 'verifying', status: 'current', at: 50 });
    expect(steps.find((s) => s.phase === 'executing')).toEqual({ phase: 'executing', status: 'done', at: 100 });
    // 'validating' never got its own event even though the run is past it —
    // honestly reflects the event log rather than inferring a gap.
    expect(steps.find((s) => s.phase === 'validating')).toEqual({ phase: 'validating', status: 'pending', at: null });
  });

  it('ignores non-phase lifecycle events and non-lifecycle events', () => {
    const events: RunEvent[] = [
      evt(1, { event: 'started' }),
      { id: 2, runId: 1, seq: 2, ts: 2, type: 'session_update', payload: { sessionUpdate: 'agent_message_chunk' } },
      phaseEvt(3, 'executing', 30),
    ];
    const steps = phaseTimelineFromEvents(events, 'executing', 'running');
    expect(steps.find((s) => s.phase === 'executing')).toEqual({ phase: 'executing', status: 'current', at: 30 });
  });

  it('ignores a phase value not found in RUN_PHASES', () => {
    const events = [phaseEvt(1, 'bogus-phase', 10)];
    const steps = phaseTimelineFromEvents(events, null, 'running');
    expect(steps.every((s) => s.at === null)).toBe(true);
  });
});
