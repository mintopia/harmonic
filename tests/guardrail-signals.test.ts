import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatProgressReason, toProgressEvents, type RunEventLike } from '../src/domain/guardrail-progress.js';
import { detectStall } from '../src/domain/stall-detector.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { GuardrailEventStore } from '../src/domain/guardrail-events.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';
import { describeGuardrailTrip, guardrailDimensionLabel } from '../web/src/guardrail-trip-model.js';
import type { GuardrailEvent } from '../web/src/types.js';

describe('guardrail progress', () => {
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
      expect(detectStall(toProgressEvents(log), { enabled: true })).toBeNull();

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
});

describe('guardrail events', () => {
  describe('GuardrailEventStore (issue #127)', () => {
    let dir: string;
    let asyncDb: AsyncDbHandle;
    let events: GuardrailEventStore;
    let attemptId: number;
    let otherAttemptId: number;

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'harmonic-guardrail-events-'));
      asyncDb = await openAsyncDb(dir);
      await seedWorkspace(asyncDb);
      const settingsStore = await makeSettingsStore(dir);
      const tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
      const attempts = new AttemptStore(asyncDb);
      events = new GuardrailEventStore(asyncDb);

      const task = await tasks.create({ prompt: 'trip me', state: 'ready' });
      attemptId = (await attempts.create(task.id)).id;
      const otherTask = await tasks.create({ prompt: 'separate log', state: 'ready' });
      otherAttemptId = (await attempts.create(otherTask.id)).id;
    });
    afterEach(async () => {
      await asyncDb.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('appends a wall-clock trip and reads it back, seq 1, fields persisted', async () => {
      const row = await events.append(attemptId, {
        dimension: 'wall-clock',
        limitValue: 3_600_000,
        observedValue: 3_600_001,
        configSource: 'default',
      });
      expect(row).toMatchObject({
        attemptId,
        seq: 1,
        dimension: 'wall-clock',
        limitValue: 3_600_000,
        observedValue: 3_600_001,
        configSource: 'default',
        payload: '{}',
      });

      const [back] = await events.list(attemptId);
      expect(back).toEqual(row);
    });

    it('payload round-trips through JSON.stringify, defaulting to {} when omitted', async () => {
      const row = await events.append(attemptId, {
        dimension: 'wall-clock',
        limitValue: 1000,
        observedValue: 1500,
        configSource: 'workspace',
        payload: { note: 'evidence', elapsedMs: 1500 },
      });
      expect(JSON.parse(row.payload)).toEqual({ note: 'evidence', elapsedMs: 1500 });

      const withoutPayload = await events.append(attemptId, {
        dimension: 'wall-clock',
        limitValue: 2000,
        observedValue: 2001,
        configSource: 'default',
      });
      expect(withoutPayload.payload).toBe('{}');
    });

    it('assigns a 1-based monotonic seq per Run, sequencing each Run independently', async () => {
      await events.append(attemptId, {
        dimension: 'wall-clock',
        limitValue: 100,
        observedValue: 101,
        configSource: 'default',
      });
      const second = await events.append(attemptId, {
        dimension: 'wall-clock',
        limitValue: 100,
        observedValue: 102,
        configSource: 'default',
      });
      expect(second.seq).toBe(2);

      const other = await events.append(otherAttemptId, {
        dimension: 'wall-clock',
        limitValue: 100,
        observedValue: 103,
        configSource: 'workspace',
      });
      expect(other.seq).toBe(1);
    });

    it("list returns a Run's events in seq order, and only that Run's", async () => {
      await events.append(attemptId, {
        dimension: 'wall-clock',
        limitValue: 100,
        observedValue: 101,
        configSource: 'default',
      });
      await events.append(attemptId, {
        dimension: 'wall-clock',
        limitValue: 100,
        observedValue: 102,
        configSource: 'default',
      });
      await events.append(otherAttemptId, {
        dimension: 'wall-clock',
        limitValue: 100,
        observedValue: 103,
        configSource: 'default',
      });

      const log = await events.list(attemptId);
      expect(log.map((e) => e.seq)).toEqual([1, 2]);
      expect(log.map((e) => e.observedValue)).toEqual([101, 102]);
    });
  });
});

describe('guardrail trip model', () => {
  const event = (overrides: Partial<GuardrailEvent>): GuardrailEvent => ({
    id: 1,
    attemptId: 1,
    seq: 1,
    ts: 1_700_000_000_000,
    dimension: 'wall-clock',
    limitValue: 0,
    observedValue: 0,
    configSource: 'default',
    payload: {},
    ...overrides,
  });

  describe('describeGuardrailTrip', () => {
    it('formats a wall-clock trip in minutes from ms', () => {
      const { dimensionLabel, evidence } = describeGuardrailTrip(
        event({ dimension: 'wall-clock', limitValue: 20 * 60_000, observedValue: 24 * 60_000 }),
      );
      expect(dimensionLabel).toMatch(/wall.clock/i);
      expect(evidence).toBe('20 min limit, ran 24 min');
    });

    it('formats a tokens trip as token counts', () => {
      const { dimensionLabel, evidence } = describeGuardrailTrip(
        event({ dimension: 'tokens', limitValue: 100_000, observedValue: 128_000 }),
      );
      expect(dimensionLabel).toMatch(/token/i);
      expect(evidence).toBe('100,000 token limit, used 128,000');
    });

    it('formats a cost trip in dollars', () => {
      const { dimensionLabel, evidence } = describeGuardrailTrip(
        event({ dimension: 'cost', limitValue: 5, observedValue: 6.2 }),
      );
      expect(dimensionLabel).toMatch(/cost/i);
      expect(evidence).toBe('$5.00 limit, spent $6.20');
    });

    it('formats a progress trip with its sentinel 0 limit and surfaces the pattern', () => {
      const { dimensionLabel, evidence } = describeGuardrailTrip(
        event({ dimension: 'progress', limitValue: 0, observedValue: 4, payload: { pattern: 'repeated-tool-loop' } }),
      );
      expect(dimensionLabel).toMatch(/progress/i);
      expect(evidence).toMatch(/no progress/i);
      expect(evidence).toContain('repeated-tool-loop');
    });

    it('formats a progress trip with no pattern payload gracefully', () => {
      const { evidence } = describeGuardrailTrip(
        event({ dimension: 'progress', limitValue: 0, observedValue: 4, payload: {} }),
      );
      expect(evidence).toMatch(/no progress/i);
    });

    it('formats a tool-timeout trip in minutes from ms', () => {
      const { dimensionLabel, evidence } = describeGuardrailTrip(
        event({ dimension: 'tool-timeout', limitValue: 5 * 60_000, observedValue: 6 * 60_000, payload: { title: 'npm test' } }),
      );
      expect(dimensionLabel).toMatch(/tool.timeout/i);
      expect(evidence).toContain('5 min limit, ran 6 min');
      expect(evidence).toContain('npm test');
    });

    it('guards an unknown dimension gracefully instead of throwing', () => {
      const { dimensionLabel, evidence } = describeGuardrailTrip(
        event({ dimension: 'made-up' as GuardrailEvent['dimension'], limitValue: 3, observedValue: 9 }),
      );
      expect(dimensionLabel).toBe('made-up');
      expect(evidence).toBe('limit 3, observed 9');
    });
  });

  describe('guardrailDimensionLabel (issue #176)', () => {
    it('maps a known raw dimension token to its human label', () => {
      expect(guardrailDimensionLabel('wall-clock')).toBe('Wall clock');
    });

    it('passes an unrecognised dimension through unchanged', () => {
      expect(guardrailDimensionLabel('made-up')).toBe('made-up');
    });
  });
});
