import { describe, expect, it } from 'vitest';
import { deckSections, isActiveEpic } from '../web/src/deck-model.js';
import type { Task, TaskState } from '../web/src/types.js';
import type { Epic, EpicMember } from '../web/src/epic-model.js';

const task = (
  id: number,
  state: TaskState,
  extra: Partial<Task> = {},
): Task => ({
  id,
  prompt: `task ${id}`,
  workspaceId: 1,
  harness: 'claude',
  model: 'claude-fable-5',
  workingDir: '/tmp',
  isolationMode: 'direct',
  priority: 'normal',
  baseBranch: null,
  overrides: { harness: null, model: null, isolationMode: null, priority: null },
  state,
  reattemptOf: null,
  feedback: null,
  createdAt: 100,
  updatedAt: 100,
  dependsOn: [],
  dependents: [],
  blockedOnFailed: false,
  reattempts: [],
  cost: null,
  origin: 'native',
  trackerRef: null,
  workflow: null,
  wayfinderType: null,
  drive: null,
  escalated: false,
  mapRef: null,
  url: null,
  mapTitle: null,
  branch: null,
  stat: null,
  runStartedAt: null,
  toolCount: null,
  runId: null,
  skipReason: null,
  ...extra,
});

const member = (ref: number, taskId: number | null, extra: Partial<EpicMember> = {}): EpicMember => ({
  ref,
  title: `member ${ref}`,
  taskId,
  state: null,
  escalated: false,
  landStatus: 'pending',
  ready: false,
  ...extra,
});

const epic = (ref: number, members: EpicMember[], extra: Partial<Epic> = {}): Epic => {
  const foldedCount = members.filter((m) => m.landStatus === 'completed').length;
  return {
    ref,
    title: `epic ${ref}`,
    kind: 'spec',
    members,
    ready: [],
    integration: { branch: `epic/${ref}`, exists: true, tip: 'a1f9c02' },
    verification: { status: 'pending' },
    land: { inFlight: false, held: null },
    foldedCount,
    memberCount: members.length,
    ...extra,
  };
};

// A fixed "now" mid-afternoon so `startOfDay` has clear same-day / prior-day
// boundaries the tests can straddle without touching a real clock.
const NOW = new Date('2026-08-20T14:00:00').getTime();
const TODAY = new Date('2026-08-20T09:30:00').getTime();
const YESTERDAY = new Date('2026-08-19T23:30:00').getTime();

describe('deckSections — attention-ordered Deck sections (issue #182)', () => {
  it('puts awaiting-review and escalated standalone tasks in Needs you, review first', () => {
    const s = deckSections(
      [
        task(1, 'ready', { escalated: true }), // escalated non-review
        task(2, 'awaiting-review'),
        task(3, 'running'), // in flight, not needs-you
      ],
      [],
      NOW,
    );
    // awaiting-review (rank 0) before escalated-only (rank 1)
    expect(s.needsYou.map((t) => t.id)).toEqual([2, 1]);
    expect(s.inFlight.map((t) => t.id)).toEqual([3]);
  });

  it('orders awaiting-review ties by priority then id (processing order)', () => {
    const s = deckSections(
      [
        task(5, 'awaiting-review', { priority: 'normal' }),
        task(4, 'awaiting-review', { priority: 'high' }),
        task(6, 'awaiting-review', { priority: 'normal' }),
      ],
      [],
      NOW,
    );
    expect(s.needsYou.map((t) => t.id)).toEqual([4, 5, 6]);
  });

  it('keeps escalated running tasks in Needs you, not In flight', () => {
    const s = deckSections([task(1, 'running', { escalated: true })], [], NOW);
    expect(s.needsYou.map((t) => t.id)).toEqual([1]);
    expect(s.inFlight).toEqual([]);
  });

  it('does NOT keep a terminal task in Needs you even if it is flagged escalated', () => {
    const s = deckSections([task(1, 'failed', { escalated: true, updatedAt: TODAY })], [], NOW);
    expect(s.needsYou).toEqual([]);
    expect(s.recent.failed).toBe(1);
  });

  it('tiers Queued ready → blocked → draft, sorting by queue order within a tier', () => {
    const s = deckSections(
      [
        task(1, 'draft'),
        task(2, 'blocked'),
        task(3, 'ready', { priority: 'normal', createdAt: 200 }),
        task(4, 'ready', { priority: 'high', createdAt: 300 }),
      ],
      [],
      NOW,
    );
    // ready (high before normal) → blocked → draft
    expect(s.queued.map((t) => t.id)).toEqual([4, 3, 2, 1]);
  });

  it('excludes escalated ready/blocked tasks from Queued (they are in Needs you)', () => {
    const s = deckSections([task(1, 'ready', { escalated: true }), task(2, 'ready')], [], NOW);
    expect(s.queued.map((t) => t.id)).toEqual([2]);
    expect(s.needsYou.map((t) => t.id)).toEqual([1]);
  });

  it('counts today’s terminal tasks in Recent, split by outcome, ignoring older ones', () => {
    const s = deckSections(
      [
        task(1, 'completed', { updatedAt: TODAY }),
        task(2, 'completed', { updatedAt: YESTERDAY }), // not today → excluded
        task(3, 'failed', { updatedAt: TODAY }),
        task(4, 'cancelled', { updatedAt: TODAY }),
      ],
      [],
      NOW,
    );
    expect(s.recent).toEqual({ landed: 1, failed: 1, cancelled: 1, total: 3 });
  });

  it('never lists a terminal task in the active row sections', () => {
    const s = deckSections([task(1, 'completed', { updatedAt: TODAY })], [], NOW);
    expect(s.needsYou).toEqual([]);
    expect(s.inFlight).toEqual([]);
    expect(s.queued).toEqual([]);
  });
});

describe('deckSections — Epic members vs standalone (issue #182)', () => {
  it('lists active Epics in Landing (ascending ref) and pulls their members out of flat sections', () => {
    const e1 = epic(44, [member(10, 101, { state: 'running' }), member(11, 102, { landStatus: 'pending' })]);
    const e2 = epic(30, [member(20, 201, { state: 'running' })]);
    const s = deckSections(
      [
        task(101, 'running'), // active-epic member → excluded
        task(102, 'ready'), // active-epic member → excluded
        task(201, 'running'), // active-epic member → excluded
        task(9, 'running'), // standalone → In flight
      ],
      [e1, e2],
      NOW,
    );
    expect(s.landing.map((e) => e.ref)).toEqual([30, 44]);
    expect(s.inFlight.map((t) => t.id)).toEqual([9]);
    expect(s.queued).toEqual([]);
  });

  it('treats a fully-folded Epic as settled: dropped from Landing, its members revert to standalone', () => {
    const folded = epic(50, [
      member(1, 501, { landStatus: 'completed', state: 'completed' }),
      member(2, 502, { landStatus: 'completed', state: 'completed' }),
    ]);
    const s = deckSections(
      [task(501, 'completed', { updatedAt: TODAY }), task(502, 'completed', { updatedAt: TODAY })],
      [folded],
      NOW,
    );
    expect(s.landing).toEqual([]);
    // now standalone → they count in Recent
    expect(s.recent.landed).toBe(2);
  });

  it('keeps a fully-folded Epic in Landing while a whole-Epic land is in flight', () => {
    const landing = epic(
      51,
      [member(1, 511, { landStatus: 'completed', state: 'completed' })],
      { land: { inFlight: true, held: null } },
    );
    const s = deckSections([task(511, 'completed', { updatedAt: TODAY })], [landing], NOW);
    expect(s.landing.map((e) => e.ref)).toEqual([51]);
    // member is still an active-epic member → not double-counted in Recent
    expect(s.recent.landed).toBe(0);
  });
});

describe('isActiveEpic (issue #182)', () => {
  it('is active while any member is unfolded', () => {
    expect(isActiveEpic(epic(1, [member(1, 1, { landStatus: 'completed' }), member(2, 2)]))).toBe(true);
  });
  it('is inactive once every member has folded and no land is in flight', () => {
    expect(isActiveEpic(epic(1, [member(1, 1, { landStatus: 'completed' })]))).toBe(false);
  });
  it('stays active if a land attempt is in flight even when fully folded', () => {
    expect(
      isActiveEpic(epic(1, [member(1, 1, { landStatus: 'completed' })], { land: { inFlight: true, held: null } })),
    ).toBe(true);
  });
  it('an empty Epic (no members) is inactive', () => {
    expect(isActiveEpic(epic(1, []))).toBe(false);
  });
});
