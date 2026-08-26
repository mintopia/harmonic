/**
 * Pure `composeEpicView` tests (issue #167, ADR-0026). Table-style like
 * `epic-derivation.test.ts` — no I/O, exercises the composer directly against
 * hand-built `DerivedEpic`/`TaskRow`/facts inputs.
 */
import { describe, expect, it } from 'vitest';
import { composeEpicView, type EpicFacts } from '../src/domain/epic-view.js';
import type { DerivedEpic } from '../src/domain/epic-derivation.js';
import type { TaskRow } from '../src/db/schema.js';

const derived = (over: Partial<DerivedEpic> = {}): DerivedEpic => ({
  ref: 10,
  title: 'Spec',
  kind: 'spec',
  members: [11, 12, 13],
  ready: [13],
  ...over,
});

const task = (over: Partial<TaskRow>): TaskRow =>
  ({
    id: 1,
    prompt: '',
    workingDir: '/repo',
    state: 'running',
    workspaceId: 1,
    reattemptOf: null,
    feedback: null,
    continuationChoice: null,
    origin: 'mirrored',
    trackerRef: null,
    workflow: 'implement',
    wayfinderType: null,
    mapRef: null,
    baseBranch: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as TaskRow;

const noFacts: EpicFacts = {
  integration: { branch: 'epic/10', exists: false, tip: null },
  verification: { status: null },
  land: { inFlight: false, held: null },
};

describe('composeEpicView', () => {
  it('maps a done member Task to landStatus completed, folds it in, and preserves its raw state', () => {
    const memberTasks = new Map<number, TaskRow>([[11, task({ id: 101, trackerRef: 11, state: 'done' })]]);
    const titleByRef = new Map([[11, 'Member eleven']]);
    const epic = composeEpicView(derived(), memberTasks, titleByRef, noFacts);

    const m11 = epic.members.find((m) => m.ref === 11);
    expect(m11).toEqual({
      ref: 11,
      title: 'Member eleven',
      taskId: 101,
      state: 'done',
      escalated: false,
      landStatus: 'completed',
      ready: false,
    });
    expect(epic.foldedCount).toBe(1);
  });

  it('maps an escalated member to landStatus blocked', () => {
    const memberTasks = new Map<number, TaskRow>([[12, task({ id: 102, trackerRef: 12, state: 'escalated', escalationReason: 'escalated to human: attempt 3 of 3 failed' })]]);
    const epic = composeEpicView(derived(), memberTasks, new Map(), noFacts);

    const m12 = epic.members.find((m) => m.ref === 12);
    expect(m12?.landStatus).toBe('blocked');
    expect(m12?.escalated).toBe(true);
    expect(epic.foldedCount).toBe(0);
  });

  it('maps an unmirrored member (no matching Task row) to pending, null taskId/state, empty title', () => {
    const epic = composeEpicView(derived(), new Map(), new Map(), noFacts);
    const m13 = epic.members.find((m) => m.ref === 13);
    expect(m13).toEqual({
      ref: 13,
      title: '',
      taskId: null,
      state: null,
      escalated: false,
      landStatus: 'pending',
      ready: true,
    });
  });

  it('flags only ready-frontier refs as ready:true and echoes the ready list ascending', () => {
    const epic = composeEpicView(derived({ members: [11, 12, 13], ready: [11, 13] }), new Map(), new Map(), noFacts);
    expect(epic.members.map((m) => ({ ref: m.ref, ready: m.ready }))).toEqual([
      { ref: 11, ready: true },
      { ref: 12, ready: false },
      { ref: 13, ready: true },
    ]);
    expect(epic.ready).toEqual([11, 13]);
  });

  it('foldedCount counts only completed members; memberCount is the full member list length', () => {
    const memberTasks = new Map<number, TaskRow>([
      [11, task({ id: 1, trackerRef: 11, state: 'done' })],
      [12, task({ id: 2, trackerRef: 12, state: 'done' })],
      [13, task({ id: 3, trackerRef: 13, state: 'working' })],
    ]);
    const epic = composeEpicView(derived(), memberTasks, new Map(), noFacts);
    expect(epic.foldedCount).toBe(2);
    expect(epic.memberCount).toBe(3);
  });

  it('passes integration/verification/land facts through unchanged, including branch absent (exists:false, tip:null)', () => {
    const facts: EpicFacts = {
      integration: { branch: 'epic/10', exists: false, tip: null },
      verification: { status: null },
      land: { inFlight: false, held: null },
    };
    const epic = composeEpicView(derived({ members: [], ready: [] }), new Map(), new Map(), facts);
    expect(epic.integration).toEqual({ branch: 'epic/10', exists: false, tip: null });
    expect(epic.verification).toEqual({ status: null });
    expect(epic.land).toEqual({ inFlight: false, held: null });
    expect(epic.memberCount).toBe(0);
    expect(epic.foldedCount).toBe(0);
  });

  it('passes a present branch (exists:true, non-null tip), in-flight land, and a hold reason through unchanged', () => {
    const facts: EpicFacts = {
      integration: { branch: 'epic/10', exists: true, tip: 'a1b2c3d' },
      verification: { status: 'pass' },
      land: { inFlight: true, held: 'already escalated for this member state; awaiting operator or a state change' },
    };
    const epic = composeEpicView(derived({ members: [], ready: [] }), new Map(), new Map(), facts);
    expect(epic.integration).toEqual({ branch: 'epic/10', exists: true, tip: 'a1b2c3d' });
    expect(epic.verification).toEqual({ status: 'pass' });
    expect(epic.land).toEqual({ inFlight: true, held: expect.stringContaining('escalated') });
  });

  it('carries ref/title/kind straight from the DerivedEpic', () => {
    const epic = composeEpicView(derived({ ref: 42, title: 'Map it', kind: 'map', members: [], ready: [] }), new Map(), new Map(), noFacts);
    expect(epic.ref).toBe(42);
    expect(epic.title).toBe('Map it');
    expect(epic.kind).toBe('map');
  });
});
