import { describe, expect, it } from 'vitest';
import { composeEpicView, type EpicFacts, type EpicMeta } from '../src/domain/epic-view.js';
import type { DerivedEpic } from '../src/domain/epic-derivation.js';
import type { TaskRow } from '../src/db/schema.js';

const derived = (over: Partial<DerivedEpic> = {}): DerivedEpic => ({
  ref: 10,
  title: 'Spec',
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
  verification: { status: null, configured: false },
  integrate: { inFlight: false, held: null, phase: null },
  mergeSteps: [],
};

const noMeta: EpicMeta = { description: '', createdAt: 0, baseBranch: null, dependsOn: [], kind: 'spec', state: 'open' };

describe('composeEpicView', () => {
  it('maps a done member Task to mergeStatus completed, folds it in, and preserves its raw state', () => {
    const memberTasks = new Map<number, TaskRow>([[11, task({ id: 101, trackerRef: 11, state: 'done' })]]);
    const titleByRef = new Map([[11, 'Member eleven']]);
    const epic = composeEpicView(derived(), memberTasks, titleByRef, noFacts, noMeta);

    const m11 = epic.members.find((m) => m.ref === 11);
    expect(m11).toEqual({
      ref: 11,
      title: 'Member eleven',
      taskId: 101,
      state: 'done',
      escalated: false,
      mergeStatus: 'completed',
      ready: false,
    });
    expect(epic.foldedCount).toBe(1);
  });

  it('maps an escalated member to mergeStatus blocked', () => {
    const memberTasks = new Map<number, TaskRow>([[12, task({ id: 102, trackerRef: 12, state: 'escalated', escalationReason: 'escalated to human: attempt 3 of 3 failed' })]]);
    const epic = composeEpicView(derived(), memberTasks, new Map(), noFacts, noMeta);

    const m12 = epic.members.find((m) => m.ref === 12);
    expect(m12?.mergeStatus).toBe('blocked');
    expect(m12?.escalated).toBe(true);
    expect(epic.foldedCount).toBe(0);
  });

  it('maps an unmirrored member (no matching Task row) to pending, null taskId/state, empty title', () => {
    const epic = composeEpicView(derived(), new Map(), new Map(), noFacts, noMeta);
    const m13 = epic.members.find((m) => m.ref === 13);
    expect(m13).toEqual({
      ref: 13,
      title: '',
      taskId: null,
      state: null,
      escalated: false,
      mergeStatus: 'pending',
      ready: true,
    });
  });

  it('flags only ready-frontier refs as ready:true and echoes the ready list ascending', () => {
    const epic = composeEpicView(derived({ members: [11, 12, 13], ready: [11, 13] }), new Map(), new Map(), noFacts, noMeta);
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
    const epic = composeEpicView(derived(), memberTasks, new Map(), noFacts, noMeta);
    expect(epic.foldedCount).toBe(2);
    expect(epic.memberCount).toBe(3);
  });

  it('passes integration/verification/integrate facts through unchanged, including branch absent (exists:false, tip:null)', () => {
    const facts: EpicFacts = {
      integration: { branch: 'epic/10', exists: false, tip: null },
      verification: { status: null, configured: false },
      integrate: { inFlight: false, held: null, phase: null },
      mergeSteps: [],
    };
    const epic = composeEpicView(derived({ members: [], ready: [] }), new Map(), new Map(), facts, noMeta);
    expect(epic.integration).toEqual({ branch: 'epic/10', exists: false, tip: null });
    expect(epic.verification).toEqual({ status: null, configured: false });
    expect(epic.integrate).toEqual({ inFlight: false, held: null, phase: null });
    expect(epic.memberCount).toBe(0);
    expect(epic.foldedCount).toBe(0);
  });

  it('passes a present branch (exists:true, non-null tip), in-flight integrate, and a hold reason through unchanged', () => {
    const facts: EpicFacts = {
      integration: { branch: 'epic/10', exists: true, tip: 'a1b2c3d' },
      verification: { status: 'pass', configured: true },
      integrate: { inFlight: true, held: 'already escalated for this member state; awaiting operator or a state change', phase: null },
      mergeSteps: [],
    };
    const epic = composeEpicView(derived({ members: [], ready: [] }), new Map(), new Map(), facts, noMeta);
    expect(epic.integration).toEqual({ branch: 'epic/10', exists: true, tip: 'a1b2c3d' });
    expect(epic.verification).toEqual({ status: 'pass', configured: true });
    expect(epic.integrate).toEqual({ inFlight: true, held: expect.stringContaining('escalated'), phase: null });
  });

  it('carries ref/title from the DerivedEpic and kind from the meta record', () => {
    const epic = composeEpicView(
      derived({ ref: 42, title: 'Map it', members: [], ready: [] }),
      new Map(),
      new Map(),
      noFacts,
      { ...noMeta, kind: 'map' },
    );
    expect(epic.ref).toBe(42);
    expect(epic.title).toBe('Map it');
    expect(epic.kind).toBe('map');
  });

  it('carries the container-ticket meta (description, createdAt, dependsOn) and derives updatedAt from the latest member activity (ADR-0017)', () => {
    const memberTasks = new Map<number, TaskRow>([
      [11, task({ id: 1, trackerRef: 11, updatedAt: 500 })],
      [12, task({ id: 2, trackerRef: 12, updatedAt: 900 })],
    ]);
    const epic = composeEpicView(derived({ members: [11, 12], ready: [] }), memberTasks, new Map(), noFacts, {
      description: 'The epic body.',
      createdAt: 1_700_000_000_000,
      baseBranch: 'develop',
      dependsOn: [7, 3],
      kind: 'spec',
      state: 'open',
    });
    expect(epic.description).toBe('The epic body.');
    expect(epic.createdAt).toBe(1_700_000_000_000);
    expect(epic.dependsOn).toEqual([7, 3]);
    expect(epic.updatedAt).toBe(900);
  });

  it('leaves updatedAt null when no member is mirrored', () => {
    const epic = composeEpicView(derived({ members: [11], ready: [] }), new Map(), new Map(), noFacts, noMeta);
    expect(epic.updatedAt).toBeNull();
  });
});
