import { describe, expect, it } from 'vitest';
import { formatProgressReason, toProgressEvents, type RunEventLike } from '../src/domain/guardrail-progress.js';
import { detectStall } from '../src/domain/stall-detector.js';

// Tiny inline builders for RunEventLike, mirroring stall-detector.test.ts's idiom.
const toolCall = (seq: number, toolCallId: string, extra: Record<string, unknown> = {}): RunEventLike => ({
  seq,
  type: 'session_update',
  payload: { sessionUpdate: 'tool_call', toolCallId, ...extra },
});
const toolCallUpdate = (
  seq: number,
  toolCallId: string,
  status: string,
  extra: Record<string, unknown> = {},
): RunEventLike => ({
  seq,
  type: 'session_update',
  payload: { sessionUpdate: 'tool_call_update', toolCallId, status, ...extra },
});
const messageChunk = (seq: number): RunEventLike => ({
  seq,
  type: 'session_update',
  payload: { sessionUpdate: 'agent_message_chunk' },
});
const contentWith = (text: string) => [{ type: 'content', content: { type: 'text', text } }];

describe('toProgressEvents (issue #131)', () => {
  it('maps a tool_call to an action with ref + signature (title preferred over kind)', () => {
    const events = toProgressEvents([toolCall(1, 'tc-1', { title: 'Run tests', kind: 'execute' })]);
    expect(events).toEqual([{ seq: 1, kind: 'action', signature: 'Run tests', ref: 'tc-1' }]);
  });

  it('falls back to kind when title is absent', () => {
    const events = toProgressEvents([toolCall(1, 'tc-1', { kind: 'execute' })]);
    expect(events).toEqual([{ seq: 1, kind: 'action', signature: 'execute', ref: 'tc-1' }]);
  });

  it('signature is undefined when neither title nor kind is a usable string', () => {
    const events = toProgressEvents([toolCall(1, 'tc-1', { title: '' })]);
    expect(events).toEqual([{ seq: 1, kind: 'action', signature: undefined, ref: 'tc-1' }]);
  });

  it('maps a completed tool_call_update to a result with a digest signature', () => {
    const events = toProgressEvents([
      toolCallUpdate(2, 'tc-1', 'completed', { content: contentWith('all good, 12 tests passed') }),
    ]);
    expect(events).toEqual([{ seq: 2, kind: 'result', signature: 'all good, 12 tests passed', ref: 'tc-1' }]);
  });

  it('maps a failed tool_call_update to an error with a digest signature', () => {
    const events = toProgressEvents([
      toolCallUpdate(2, 'tc-1', 'failed', { content: contentWith('boom: exit code 1') }),
    ]);
    expect(events).toEqual([{ seq: 2, kind: 'error', signature: 'boom: exit code 1', ref: 'tc-1' }]);
  });

  it('digest handles alternate content block shapes and slices to 64 chars', () => {
    const long = 'x'.repeat(100);
    expect(toProgressEvents([toolCallUpdate(1, 't', 'completed', { content: [{ type: 'text', text: long }] })])).toEqual(
      [{ seq: 1, kind: 'result', signature: long.slice(0, 64), ref: 't' }],
    );
    expect(
      toProgressEvents([toolCallUpdate(1, 't', 'completed', { content: [{ content: { type: 'text', text: 'hi' } }] })]),
    ).toEqual([{ seq: 1, kind: 'result', signature: 'hi', ref: 't' }]);
  });

  it('digest is undefined when no text block is present', () => {
    const events = toProgressEvents([toolCallUpdate(2, 'tc-1', 'completed', { content: [{ type: 'image' }] })]);
    expect(events).toEqual([{ seq: 2, kind: 'result', signature: undefined, ref: 'tc-1' }]);
    expect(toProgressEvents([toolCallUpdate(3, 'tc-1', 'completed', {})])).toEqual([
      { seq: 3, kind: 'result', signature: undefined, ref: 'tc-1' },
    ]);
  });

  it('skips tool_call_update with status in_progress or pending', () => {
    expect(toProgressEvents([toolCallUpdate(1, 'tc-1', 'in_progress')])).toEqual([]);
    expect(toProgressEvents([toolCallUpdate(1, 'tc-1', 'pending')])).toEqual([]);
  });

  it('maps agent_message_chunk to a message with no signature/ref', () => {
    expect(toProgressEvents([messageChunk(5)])).toEqual([{ seq: 5, kind: 'message', signature: undefined, ref: undefined }]);
  });

  it('skips non-session_update events', () => {
    const events: RunEventLike[] = [
      { seq: 1, type: 'lifecycle', payload: { event: 'merged' } },
      { seq: 2, type: 'permission_request', payload: {} },
    ];
    expect(toProgressEvents(events)).toEqual([]);
  });

  it('skips an unrecognized sessionUpdate kind', () => {
    const events: RunEventLike[] = [{ seq: 1, type: 'session_update', payload: { sessionUpdate: 'plan' } }];
    expect(toProgressEvents(events)).toEqual([]);
  });

  it('carries seq through unchanged across a mixed log', () => {
    const events = toProgressEvents([
      toolCall(10, 'tc-1', { title: 'A' }),
      toolCallUpdate(11, 'tc-1', 'completed', { content: contentWith('ok') }),
      messageChunk(12),
    ]);
    expect(events.map((e) => e.seq)).toEqual([10, 11, 12]);
  });

  describe('end-to-end with detectStall', () => {
    it('3 identical failing tool_call/tool_call_update(failed) pairs -> action-error-repeat', () => {
      const log: RunEventLike[] = [];
      let seq = 1;
      for (let i = 0; i < 3; i++) {
        log.push(toolCall(seq++, `tc-${i}`, { title: 'Run build' }));
        log.push(toolCallUpdate(seq++, `tc-${i}`, 'failed', { content: contentWith('build failed') }));
      }
      const mapped = toProgressEvents(log);
      const report = detectStall(mapped, { enabled: true });
      expect(report?.pattern).toBe('action-error-repeat');
    });

    it('3 agent_message_chunk events with no tool progress -> monologue', () => {
      const mapped = toProgressEvents([messageChunk(1), messageChunk(2), messageChunk(3)]);
      const report = detectStall(mapped, { enabled: true });
      expect(report?.pattern).toBe('monologue');
    });

    it('log ending in an unpaired tool_call -> detectStall returns null (outstanding suspend)', () => {
      const log: RunEventLike[] = [];
      let seq = 1;
      for (let i = 0; i < 3; i++) {
        log.push(toolCall(seq++, `tc-${i}`, { title: 'Run build' }));
        log.push(toolCallUpdate(seq++, `tc-${i}`, 'failed', { content: contentWith('build failed') }));
      }
      log.push(toolCall(seq++, 'tc-outstanding', { title: 'Run build' }));
      const mapped = toProgressEvents(log);
      expect(detectStall(mapped, { enabled: true })).toBeNull();
    });
  });
});

describe('replay quarantine (issue #144)', () => {
  it('drops replay-flagged session_update events, mapping only the current ones', () => {
    const log: RunEventLike[] = [
      { ...toolCall(1, 'tc-old', { title: 'Old build' }), replay: true },
      { ...toolCallUpdate(2, 'tc-old', 'completed', { content: contentWith('old result') }), replay: true },
      toolCall(3, 'tc-new', { title: 'New build' }),
      toolCallUpdate(4, 'tc-new', 'completed', { content: contentWith('new result') }),
    ];
    const mapped = toProgressEvents(log);
    expect(mapped.map((e) => e.seq)).toEqual([3, 4]);
    expect(mapped).toEqual([
      { seq: 3, kind: 'action', signature: 'New build', ref: 'tc-new' },
      { seq: 4, kind: 'result', signature: 'new result', ref: 'tc-new' },
    ]);
  });

  // AC4 ("does not advance progress/stall detection") and, transitively, AC3
  // ("does not emit run_facts for the current turn"): a `guardrail-trip` is the
  // ONLY run_fact a session/update can influence, and it fires only when
  // detectStall returns a report. Prove a replay-only trace that WOULD stall
  // yields null here — so no trip, hence no spurious guardrail-trip run_fact.
  it('a stall pattern formed entirely by replayed events does not trip (AC4/AC3); the same events as current do', () => {
    const log: RunEventLike[] = [];
    let seq = 1;
    for (let i = 0; i < 3; i++) {
      log.push({ ...toolCall(seq++, `tc-${i}`, { title: 'Run build' }), replay: true });
      log.push({
        ...toolCallUpdate(seq++, `tc-${i}`, 'failed', { content: contentWith('build failed') }),
        replay: true,
      });
    }
    // Replay-only: no stall report → the guardrail-trip run_fact never fires.
    expect(detectStall(toProgressEvents(log), { enabled: true })).toBeNull();

    // The SAME trace as current-turn work does trip — proving the quarantine,
    // not a too-short trace, is what suppressed the stall (and the fact).
    const currentLog: RunEventLike[] = log.map((event) => ({ ...event, replay: false }));
    const report = detectStall(toProgressEvents(currentLog), { enabled: true });
    expect(report?.pattern).toBe('action-error-repeat');
  });
});

describe('formatProgressReason (issue #131, ADR-0019)', () => {
  it('renders each pattern to its card reason', () => {
    expect(formatProgressReason({ pattern: 'action-error-repeat' })).toBe('stalled: repeated failing action');
    expect(formatProgressReason({ pattern: 'action-result-repeat' })).toBe('stalled: repeated action');
    expect(formatProgressReason({ pattern: 'alternating-loop' })).toBe('stalled: looping between two actions');
    expect(formatProgressReason({ pattern: 'monologue' })).toBe('stalled: no tool progress');
  });
});
