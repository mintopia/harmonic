import { describe, expect, it } from 'vitest';
import type { EpicLifecycleState, TaskState } from '../src/db/schema.js';
import {
  epicHoldKey,
  hasEpicKindBlockers,
  namesEpicBlocker,
  unsatisfiedEpicBlockers,
  type EpicHoldIndex,
} from '../src/domain/epic-hold.js';
import { trackerRef, type TrackerRef } from '../src/tracker/adapter.js';

const ref = (n: number): TrackerRef => trackerRef(n);

interface Spec {
  containers?: Array<{ ws?: number; ref: number; parent?: number; blockedBy?: number[] }>;
  epics?: Array<{ ws?: number; ref: number; state: EpicLifecycleState }>;
  tasks?: Array<{ ws?: number; ref: number; state: TaskState }>;
}

function index(spec: Spec): EpicHoldIndex {
  return {
    containers: new Map(
      (spec.containers ?? []).map((c) => [
        epicHoldKey(c.ws ?? 1, ref(c.ref)),
        { parent: c.parent === undefined ? null : ref(c.parent), blockedBy: (c.blockedBy ?? []).map(ref) },
      ]),
    ),
    epicStates: new Map((spec.epics ?? []).map((e) => [epicHoldKey(e.ws ?? 1, ref(e.ref)), e.state])),
    taskStates: new Map((spec.tasks ?? []).map((t) => [epicHoldKey(t.ws ?? 1, ref(t.ref)), t.state])),
  };
}

describe('unsatisfiedEpicBlockers', () => {
  it('holds a Member while the blocker Epic is open or integrating and releases it once integrated', () => {
    for (const state of ['open', 'integrating'] as const) {
      const held = unsatisfiedEpicBlockers(
        1,
        ref(73),
        index({ containers: [{ ref: 73, blockedBy: [71] }, { ref: 71 }], epics: [{ ref: 71, state }, { ref: 73, state: 'open' }] }),
      );
      expect(held).toEqual([{ ref: ref(71), kind: 'epic', heldEpic: ref(73) }]);
    }
    const released = index({ containers: [{ ref: 73, blockedBy: [71] }, { ref: 71 }], epics: [{ ref: 71, state: 'integrated' }] });
    expect(unsatisfiedEpicBlockers(1, ref(73), released)).toEqual([]);
  });

  it('holds on a Task blocker until it is done, including cancelled and escalated', () => {
    const containers = [{ ref: 73, blockedBy: [50] }];
    for (const state of ['ready', 'working', 'cancelled', 'escalated'] as const) {
      expect(unsatisfiedEpicBlockers(1, ref(73), index({ containers, tasks: [{ ref: 50, state }] }))).toEqual([
        { ref: ref(50), kind: 'task', heldEpic: ref(73) },
      ]);
    }
    expect(unsatisfiedEpicBlockers(1, ref(73), index({ containers, tasks: [{ ref: 50, state: 'done' }] }))).toEqual([]);
  });

  it('ignores an unknown blocker ref and a Member with no parent', () => {
    expect(unsatisfiedEpicBlockers(1, ref(73), index({ containers: [{ ref: 73, blockedBy: [999] }] }))).toEqual([]);
    expect(unsatisfiedEpicBlockers(1, null, index({ containers: [{ ref: 73, blockedBy: [71] }] }))).toEqual([]);
  });

  it('skips a blocker that is the Member own ancestor', () => {
    const idx = index({ containers: [{ ref: 73, blockedBy: [70, 73] }, { ref: 72, parent: 70 }, { ref: 70 }], epics: [{ ref: 70, state: 'open' }] });
    expect(unsatisfiedEpicBlockers(1, ref(70), idx)).toEqual([]);
    expect(unsatisfiedEpicBlockers(1, ref(73), idx)).toEqual([{ ref: ref(70), kind: 'epic', heldEpic: ref(73) }]);
  });

  it('lets a parent Epic blocker gate the Members of its child Epic', () => {
    const idx = index({
      containers: [{ ref: 10, blockedBy: [71] }, { ref: 11, parent: 10 }, { ref: 71 }],
      epics: [{ ref: 71, state: 'open' }],
    });
    expect(unsatisfiedEpicBlockers(1, ref(11), idx)).toEqual([{ ref: ref(71), kind: 'epic', heldEpic: ref(10) }]);
  });

  it('resolves a non-Epic container blocker through the stored Epics beneath it', () => {
    const containers = [{ ref: 73, blockedBy: [60] }, { ref: 60 }, { ref: 61, parent: 60 }, { ref: 62, parent: 60 }];
    const open = index({ containers, epics: [{ ref: 61, state: 'integrated' }, { ref: 62, state: 'open' }] });
    expect(unsatisfiedEpicBlockers(1, ref(73), open)).toHaveLength(1);
    const done = index({ containers, epics: [{ ref: 61, state: 'integrated' }, { ref: 62, state: 'integrated' }] });
    expect(unsatisfiedEpicBlockers(1, ref(73), done)).toEqual([]);
    expect(unsatisfiedEpicBlockers(1, ref(73), index({ containers }))).toEqual([]);
  });

  it('holds both sides of an Epic blocked-by cycle and flags it', () => {
    const idx = index({
      containers: [{ ref: 1, blockedBy: [2] }, { ref: 2, blockedBy: [1] }],
      epics: [{ ref: 1, state: 'open' }, { ref: 2, state: 'open' }],
    });
    expect(unsatisfiedEpicBlockers(1, ref(1), idx)).toEqual([{ ref: ref(2), kind: 'epic', heldEpic: ref(1), cycle: true }]);
    expect(unsatisfiedEpicBlockers(1, ref(2), idx)).toEqual([{ ref: ref(1), kind: 'epic', heldEpic: ref(2), cycle: true }]);
  });

  it('does not leak a same-ref blocker across Workspaces', () => {
    const idx = index({
      containers: [{ ws: 1, ref: 73, blockedBy: [71] }],
      epics: [{ ws: 2, ref: 71, state: 'open' }, { ws: 1, ref: 71, state: 'integrated' }],
    });
    expect(unsatisfiedEpicBlockers(1, ref(73), idx)).toEqual([]);
    expect(unsatisfiedEpicBlockers(2, ref(73), idx)).toEqual([]);
  });
});

describe('namesEpicBlocker and hasEpicKindBlockers', () => {
  const idx = index({
    containers: [{ ref: 10, blockedBy: [71, 50] }, { ref: 11, parent: 10 }, { ref: 20, blockedBy: [50] }],
    epics: [{ ref: 71, state: 'integrated' }],
    tasks: [{ ref: 50, state: 'done' }],
  });

  it('names a blocker through the ancestor chain whether or not it is satisfied', () => {
    expect(namesEpicBlocker(1, ref(11), ref(71), idx)).toBe(true);
    expect(namesEpicBlocker(1, ref(11), ref(99), idx)).toBe(false);
  });

  it('counts only Epic-kind blockers, satisfied or not', () => {
    expect(hasEpicKindBlockers(1, ref(11), idx)).toBe(true);
    expect(hasEpicKindBlockers(1, ref(20), idx)).toBe(false);
  });
});
