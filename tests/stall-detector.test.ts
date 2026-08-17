import { describe, expect, it } from 'vitest';
import { detectStall, type ProgressEvent } from '../src/domain/stall-detector.js';

// Tiny inline builders, mirroring the run-disposition/event-stream-model idiom:
// each test reads as a short literal event array.
const action = (seq: number, signature: string, ref?: string): ProgressEvent => ({ seq, kind: 'action', signature, ref });
const result = (seq: number, signature: string, ref?: string): ProgressEvent => ({ seq, kind: 'result', signature, ref });
const errored = (seq: number, signature: string | undefined, ref?: string): ProgressEvent => ({
  seq,
  kind: 'error',
  signature,
  ref,
});
const msg = (seq: number): ProgressEvent => ({ seq, kind: 'message' });

describe('detectStall (issue #130)', () => {
  it('returns null on empty input (enabled)', () => {
    expect(detectStall([], { enabled: true })).toBeNull();
  });

  describe('off by default', () => {
    // A blatant action-error-repeat trace: without an explicit opt-in, this
    // must never flag, no matter how loop-shaped the trace is.
    const loopy: ProgressEvent[] = [
      action(1, 'A'),
      errored(2, 'e1'),
      action(3, 'A'),
      errored(4, 'e2'),
      action(5, 'A'),
      errored(6, 'e3'),
    ];

    it('returns null with no options at all', () => {
      expect(detectStall(loopy)).toBeNull();
    });

    it('returns null with options but enabled: false', () => {
      expect(detectStall(loopy, { enabled: false })).toBeNull();
    });
  });

  describe('action-result-repeat', () => {
    it('trips on 3 identical (action A -> result rA) pairs', () => {
      const events: ProgressEvent[] = [
        action(1, 'A'),
        result(2, 'rA'),
        action(3, 'A'),
        result(4, 'rA'),
        action(5, 'A'),
        result(6, 'rA'),
      ];
      expect(detectStall(events, { enabled: true })).toEqual({
        pattern: 'action-result-repeat',
        seqs: [1, 2, 3, 4, 5, 6],
        signatures: ['A'],
        count: 3,
      });
    });

    it('does not trip below threshold (only 2 identical pairs)', () => {
      const events: ProgressEvent[] = [action(1, 'A'), result(2, 'rA'), action(3, 'A'), result(4, 'rA')];
      expect(detectStall(events, { enabled: true })).toBeNull();
    });

    it('does not merge results with a different outcome signature', () => {
      const events: ProgressEvent[] = [
        action(1, 'A'),
        result(2, 'rA'),
        action(3, 'A'),
        result(4, 'rB'),
        action(5, 'A'),
        result(6, 'rA'),
      ];
      expect(detectStall(events, { enabled: true })).toBeNull();
    });
  });

  describe('action-error-repeat', () => {
    it('trips on the same action erroring 3x, even with different (or undefined) error signatures', () => {
      const events: ProgressEvent[] = [
        action(1, 'A'),
        errored(2, 'e1'),
        action(3, 'A'),
        errored(4, undefined),
        action(5, 'A'),
        errored(6, 'e3'),
      ];
      expect(detectStall(events, { enabled: true })).toEqual({
        pattern: 'action-error-repeat',
        seqs: [1, 2, 3, 4, 5, 6],
        signatures: ['A'],
        count: 3,
      });
    });

    it('does not trip below threshold (only 2 errors in a row)', () => {
      const events: ProgressEvent[] = [action(1, 'A'), errored(2, 'e1'), action(3, 'A'), errored(4, 'e2')];
      expect(detectStall(events, { enabled: true })).toBeNull();
    });

    it('clears once the loop recovers (3 errors then a success is not stuck right now)', () => {
      const events: ProgressEvent[] = [
        action(1, 'A'),
        errored(2, 'e1'),
        action(3, 'A'),
        errored(4, 'e2'),
        action(5, 'A'),
        errored(6, 'e3'),
        action(7, 'A'),
        result(8, 'rA'), // recovered: the tail is no longer an error run
      ];
      expect(detectStall(events, { enabled: true })).toBeNull();
    });
  });

  describe('alternating-loop', () => {
    it('trips on A,B,A,B,A,B (3 full cycles)', () => {
      const events: ProgressEvent[] = [
        action(1, 'A'),
        result(2, 'rA'),
        action(3, 'B'),
        result(4, 'rB'),
        action(5, 'A'),
        result(6, 'rA'),
        action(7, 'B'),
        result(8, 'rB'),
        action(9, 'A'),
        result(10, 'rA'),
        action(11, 'B'),
        result(12, 'rB'),
      ];
      expect(detectStall(events, { enabled: true })).toEqual({
        pattern: 'alternating-loop',
        seqs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        signatures: ['A', 'B'],
        count: 3,
      });
    });

    it('does not trip on A,B,A,B (only 2 cycles)', () => {
      const events: ProgressEvent[] = [
        action(1, 'A'),
        result(2, 'rA'),
        action(3, 'B'),
        result(4, 'rB'),
        action(5, 'A'),
        result(6, 'rA'),
        action(7, 'B'),
        result(8, 'rB'),
      ];
      expect(detectStall(events, { enabled: true })).toBeNull();
    });

    it('does not flag two alternating actions whose results progress each round (genuine paginated work)', () => {
      const events: ProgressEvent[] = [
        action(1, 'listPage'),
        result(2, 'page1of5'),
        action(3, 'fetchDetail'),
        result(4, 'detailA'),
        action(5, 'listPage'),
        result(6, 'page2of5'),
        action(7, 'fetchDetail'),
        result(8, 'detailB'),
        action(9, 'listPage'),
        result(10, 'page3of5'),
        action(11, 'fetchDetail'),
        result(12, 'detailC'),
      ];
      expect(detectStall(events, { enabled: true })).toBeNull();
    });

    it('trips on one action flapping between two fixed results (same action, distinct results)', () => {
      const events: ProgressEvent[] = [
        action(1, 'toggle'),
        result(2, 'on'),
        action(3, 'toggle'),
        result(4, 'off'),
        action(5, 'toggle'),
        result(6, 'on'),
        action(7, 'toggle'),
        result(8, 'off'),
        action(9, 'toggle'),
        result(10, 'on'),
        action(11, 'toggle'),
        result(12, 'off'),
      ];
      expect(detectStall(events, { enabled: true })).toEqual({
        pattern: 'alternating-loop',
        seqs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        signatures: ['toggle', 'toggle'],
        count: 3,
      });
    });
  });

  describe('monologue', () => {
    it('trips on 3 trailing messages with no tool progress', () => {
      const events: ProgressEvent[] = [msg(1), msg(2), msg(3)];
      expect(detectStall(events, { enabled: true })).toEqual({
        pattern: 'monologue',
        seqs: [1, 2, 3],
        signatures: [],
        count: 3,
      });
    });

    it('does not trip on only 2 trailing messages', () => {
      const events: ProgressEvent[] = [msg(1), msg(2)];
      expect(detectStall(events, { enabled: true })).toBeNull();
    });

    it('resets the run when a completed tool step interrupts the messages', () => {
      const events: ProgressEvent[] = [msg(1), msg(2), action(3, 'A'), result(4, 'rA'), msg(5)];
      expect(detectStall(events, { enabled: true })).toBeNull();
    });
  });

  describe('the suspend guard (outstanding tool calls never flag)', () => {
    it('a single outstanding action with no result yet returns null', () => {
      const events: ProgressEvent[] = [action(1, 'build', 't1')];
      expect(detectStall(events, { enabled: true })).toBeNull();
    });

    it('an action-error-repeat loop followed by a trailing outstanding action is suspended', () => {
      const events: ProgressEvent[] = [
        action(1, 'A'),
        errored(2, 'e1'),
        action(3, 'A'),
        errored(4, 'e2'),
        action(5, 'A'),
        errored(6, 'e3'),
        action(7, 'A', 't9'), // never resolved
      ];
      expect(detectStall(events, { enabled: true })).toBeNull();
    });

    it('a completed slow tool (action then a much-later result) does not flag by itself', () => {
      const events: ProgressEvent[] = [action(1, 'slow', 't1'), result(50, 'done', 't1')];
      expect(detectStall(events, { enabled: true })).toBeNull();
    });

    it('a stale orphaned action from earlier history does not blind a later real loop', () => {
      // The orphan (t0) never gets a result, but the agent plainly moved on and
      // is now hammering a different action that keeps erroring — that loop must
      // still be caught; a single lost result must not disable the Guardrail.
      const events: ProgressEvent[] = [
        action(1, 'orphan', 't0'), // result never emitted
        action(2, 'A', 't1'),
        errored(3, 'e1', 't1'),
        action(4, 'A', 't2'),
        errored(5, 'e2', 't2'),
        action(6, 'A', 't3'),
        errored(7, 'e3', 't3'),
      ];
      expect(detectStall(events, { enabled: true })).toEqual({
        pattern: 'action-error-repeat',
        seqs: [2, 3, 4, 5, 6, 7],
        signatures: ['A'],
        count: 3,
      });
    });
  });

  describe('idempotency', () => {
    it('calling detectStall twice on the same trace yields deeply-equal results', () => {
      const events: ProgressEvent[] = [
        action(1, 'A'),
        result(2, 'rA'),
        action(3, 'A'),
        result(4, 'rA'),
        action(5, 'A'),
        result(6, 'rA'),
      ];
      const once = detectStall(events, { enabled: true });
      const twice = detectStall(events, { enabled: true });
      expect(once).not.toBeNull();
      expect(twice).toEqual(once);
    });
  });

  describe('ref-based pairing', () => {
    it('pairs a result to its action by ref even when messages arrive in between', () => {
      const events: ProgressEvent[] = [
        action(1, 'A', 't1'),
        msg(2),
        result(3, 'rA', 't1'),
        action(4, 'A', 't2'),
        msg(5),
        result(6, 'rA', 't2'),
        action(7, 'A', 't3'),
        msg(8),
        result(9, 'rA', 't3'),
      ];
      expect(detectStall(events, { enabled: true })).toEqual({
        pattern: 'action-result-repeat',
        seqs: [1, 3, 4, 6, 7, 9],
        signatures: ['A'],
        count: 3,
      });
    });
  });
});
