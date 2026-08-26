import { describe, expect, it } from 'vitest';
import { fmtDuration, phaseTimelineFromEvents, RUN_PHASES } from '../web/src/phase-timeline-model.js';
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
    expect(steps).toEqual(RUN_PHASES.map((phase) => ({ phase, status: 'pending', at: null, durationMs: null })));
  });

  it('marks the current phase current (with no timestamp yet) when no phase events have landed', () => {
    const steps = phaseTimelineFromEvents([], 'executing', 'running');
    expect(steps.find((s) => s.phase === 'executing')).toEqual({
      phase: 'executing',
      status: 'current',
      at: null,
      durationMs: null,
    });
    expect(steps.filter((s) => s.phase !== 'executing').every((s) => s.status === 'pending')).toBe(true);
  });

  it('marks entered phases done, the current phase current, and the rest pending for a run mid-verifying', () => {
    const events = [phaseEvt(1, 'executing', 10), phaseEvt(2, 'validating', 20), phaseEvt(3, 'verifying', 30)];
    const steps = phaseTimelineFromEvents(events, 'verifying', 'running');
    expect(steps).toEqual([
      { phase: 'executing', status: 'done', at: 10, durationMs: 10 },
      { phase: 'validating', status: 'done', at: 20, durationMs: 10 },
      { phase: 'verifying', status: 'current', at: 30, durationMs: null },
      // Nothing past 'verifying' has been entered yet, so landing/terminal
      // are genuinely not-reached — pending, not gap.
      { phase: 'landing', status: 'pending', at: null, durationMs: null },
      { phase: 'terminal', status: 'pending', at: null, durationMs: null },
    ]);
  });

  it('marks a never-entered phase gap (not pending) once a later phase has been entered, and settles reached phases to done', () => {
    const events = [
      phaseEvt(1, 'executing', 10),
      phaseEvt(2, 'validating', 20),
      phaseEvt(4, 'landing', 40),
      phaseEvt(5, 'terminal', 50),
    ];
    const steps = phaseTimelineFromEvents(events, 'terminal', 'completed');
    // 'verifying' never got its own event, but 'landing' (later in RUN_PHASES) did —
    // the run must have passed through it, so it reads as a gap, not pending.
    expect(steps.map((s) => s.status)).toEqual(['done', 'done', 'gap', 'done', 'done']);
    expect(steps.every((s) => s.status !== 'current')).toBe(true);
    expect(steps.find((s) => s.phase === 'verifying')).toEqual({
      phase: 'verifying',
      status: 'gap',
      at: null,
      durationMs: null,
    });
    expect(steps.find((s) => s.phase === 'terminal')).toEqual({
      phase: 'terminal',
      status: 'done',
      at: 50,
      durationMs: null,
    });
  });

  it('a failed/cancelled run also settles its reached phases to done with no current', () => {
    const events = [phaseEvt(1, 'executing', 10)];
    const steps = phaseTimelineFromEvents(events, 'executing', 'failed');
    expect(steps.find((s) => s.phase === 'executing')).toEqual({
      phase: 'executing',
      status: 'done',
      at: 10,
      durationMs: null,
    });
  });

  it('keeps the first occurrence timestamp and ignores a later duplicate of the same phase', () => {
    const events = [phaseEvt(1, 'executing', 100), phaseEvt(2, 'executing', 999)];
    const steps = phaseTimelineFromEvents(events, 'executing', 'running');
    expect(steps.find((s) => s.phase === 'executing')).toEqual({
      phase: 'executing',
      status: 'current',
      at: 100,
      durationMs: null,
    });
  });

  it('records an out-of-order phase event by its own timestamp, independent of array position', () => {
    // 'verifying' arrives in the array before 'executing' but with an earlier ts —
    // the array position (occurrence order), not the ts value, decides "first".
    const events = [phaseEvt(1, 'verifying', 50), phaseEvt(2, 'executing', 100)];
    const steps = phaseTimelineFromEvents(events, 'verifying', 'running');
    expect(steps.find((s) => s.phase === 'verifying')).toEqual({
      phase: 'verifying',
      status: 'current',
      at: 50,
      durationMs: null,
    });
    // executing's would-be duration falls out of the same face-value fold: its
    // nearest later 'at' (verifying's, 50, reached via the gap at validating)
    // precedes its own (100) because the events are out of order. A negative
    // span isn't a real duration, so the model reports it as null (issue #176).
    expect(steps.find((s) => s.phase === 'executing')).toEqual({
      phase: 'executing',
      status: 'done',
      at: 100,
      durationMs: null,
    });
    // 'validating' never got its own event, but 'verifying' (later in
    // RUN_PHASES) has — the run passed through it, so it's a gap now, not
    // pending (issue #176).
    expect(steps.find((s) => s.phase === 'validating')).toEqual({
      phase: 'validating',
      status: 'gap',
      at: null,
      durationMs: null,
    });
  });

  it('ignores non-phase lifecycle events and non-lifecycle events', () => {
    const events: RunEvent[] = [
      evt(1, { event: 'started' }),
      { id: 2, runId: 1, seq: 2, ts: 2, type: 'session_update', payload: { sessionUpdate: 'agent_message_chunk' } },
      phaseEvt(3, 'executing', 30),
    ];
    const steps = phaseTimelineFromEvents(events, 'executing', 'running');
    expect(steps.find((s) => s.phase === 'executing')).toEqual({
      phase: 'executing',
      status: 'current',
      at: 30,
      durationMs: null,
    });
  });

  it('ignores a phase value not found in RUN_PHASES', () => {
    const events = [phaseEvt(1, 'bogus-phase', 10)];
    const steps = phaseTimelineFromEvents(events, null, 'running');
    expect(steps.every((s) => s.at === null)).toBe(true);
    expect(steps.every((s) => s.durationMs === null)).toBe(true);
  });

  describe('gap vs pending (issue #176)', () => {
    it('reads a skipped-event phase between two entered phases as gap', () => {
      const events = [phaseEvt(1, 'executing', 10), phaseEvt(2, 'landing', 40)];
      const steps = phaseTimelineFromEvents(events, 'landing', 'running');
      // validating and verifying sit between two entered phases (executing
      // done, landing current) with no event of their own.
      expect(steps.find((s) => s.phase === 'validating')?.status).toBe('gap');
      expect(steps.find((s) => s.phase === 'verifying')?.status).toBe('gap');
    });

    it('keeps a trailing not-yet-reached phase pending, never gap, since nothing later has been entered', () => {
      const events = [phaseEvt(1, 'executing', 10), phaseEvt(2, 'validating', 20)];
      const steps = phaseTimelineFromEvents(events, 'validating', 'running');
      expect(steps.find((s) => s.phase === 'verifying')).toEqual({
        phase: 'verifying',
        status: 'pending',
        at: null,
        durationMs: null,
      });
      expect(steps.find((s) => s.phase === 'landing')?.status).toBe('pending');
      // 'terminal' is the last RUN_PHASES entry — nothing can ever be "later"
      // than it, so it can never read as gap, only pending, current or done.
      expect(steps.find((s) => s.phase === 'terminal')?.status).toBe('pending');
    });
  });

  describe('durationMs (issue #176)', () => {
    it('computes each entered phase\'s duration as the gap to the next entered phase\'s timestamp', () => {
      const events = [
        phaseEvt(1, 'executing', 0),
        phaseEvt(2, 'validating', 1_000),
        phaseEvt(4, 'landing', 4_000),
        phaseEvt(5, 'terminal', 4_200),
      ];
      const steps = phaseTimelineFromEvents(events, 'terminal', 'completed');
      expect(steps.map((s) => [s.phase, s.durationMs])).toEqual([
        ['executing', 1_000],
        // 'validating' spans to the next timestamped phase, past the gap.
        ['validating', 3_000],
        // 'verifying' is a gap: no 'at' of its own, so no duration either.
        ['verifying', null],
        ['landing', 200],
        // The last entered phase is open-ended — nothing later to close it.
        ['terminal', null],
      ]);
    });

    it('reaches past an un-entered phase to find the next timestamped one for duration', () => {
      // 'verifying' never got an event; 'landing' did — 'validating's duration
      // should span to 'landing's timestamp, not stop short at the gap.
      const events = [phaseEvt(1, 'validating', 100), phaseEvt(2, 'landing', 160)];
      const steps = phaseTimelineFromEvents(events, 'landing', 'running');
      expect(steps.find((s) => s.phase === 'validating')?.durationMs).toBe(60);
      expect(steps.find((s) => s.phase === 'verifying')?.durationMs).toBeNull();
    });

    it('is null for the current live phase (no at yet), and for gap/pending phases', () => {
      const events = [phaseEvt(1, 'executing', 10)];
      const steps = phaseTimelineFromEvents(events, 'landing', 'running');
      // 'landing' is current but has no event yet, so no 'at' and no duration.
      expect(steps.find((s) => s.phase === 'landing')).toEqual({
        phase: 'landing',
        status: 'current',
        at: null,
        durationMs: null,
      });
      // 'validating'/'verifying' are gaps (between entered 'executing' and
      // current 'landing') and, having no 'at', have no duration.
      for (const phase of ['validating', 'verifying'] as const) {
        const step = steps.find((s) => s.phase === phase);
        expect(step?.status).toBe('gap');
        expect(step?.durationMs).toBeNull();
      }
    });
  });
});

describe('fmtDuration (issue #176)', () => {
  it('formats a sub-minute span as seconds only', () => {
    expect(fmtDuration(12_000)).toBe('12s');
    expect(fmtDuration(0)).toBe('0s');
  });

  it('formats a span over a minute as "Xm Ys"', () => {
    expect(fmtDuration(80_000)).toBe('1m 20s');
    expect(fmtDuration(3_600_000)).toBe('60m 0s');
  });

  it('floors sub-second remainders rather than rounding', () => {
    expect(fmtDuration(1_999)).toBe('1s');
  });
});
