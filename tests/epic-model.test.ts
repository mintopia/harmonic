import { describe, expect, it } from 'vitest';
import {
  epicByTaskId,
  hasLiveHeal,
  landOutcomeBanner,
  memberRailStatus,
  railSegments,
  rosterLanes,
  statusLineParts,
  ROSTER_LANES,
} from '../web/src/epic-model.js';
import type { Epic, EpicLandOutcome, EpicMember } from '../web/src/epic-model.js';

const member = (overrides: Partial<EpicMember> & { ref: number }): EpicMember => ({
  title: `member ${overrides.ref}`,
  taskId: overrides.ref,
  state: null,
  escalated: false,
  landStatus: 'pending',
  ready: false,
  ...overrides,
});

const epic = (overrides: Partial<Epic> = {}): Epic => {
  const members = overrides.members ?? [];
  return {
    ref: 1,
    title: 'epic 1',
    kind: 'map',
    members,
    ready: [],
    integration: { branch: 'epic/1', exists: true, tip: null },
    verification: { status: null },
    land: { inFlight: false, held: null },
    foldedCount: members.filter((m) => m.landStatus === 'completed').length,
    memberCount: members.length,
    ...overrides,
  };
};

describe('memberRailStatus / railSegments', () => {
  it('maps completed to landed', () => {
    const m = member({ ref: 1, landStatus: 'completed' });
    expect(memberRailStatus(m, epic({ members: [m] }))).toBe('landed');
  });

  it('maps blocked to blocking', () => {
    const m = member({ ref: 1, landStatus: 'blocked' });
    expect(memberRailStatus(m, epic({ members: [m] }))).toBe('blocking');
  });

  it('maps pending + running, land not in flight, to running', () => {
    const m = member({ ref: 1, landStatus: 'pending', state: 'running' });
    const e = epic({ members: [m], land: { inFlight: false, held: null } });
    expect(memberRailStatus(m, e)).toBe('running');
  });

  it('maps pending + running, land in flight, to healing (best-effort)', () => {
    const m = member({ ref: 1, landStatus: 'pending', state: 'running' });
    const e = epic({ members: [m], land: { inFlight: true, held: null } });
    expect(memberRailStatus(m, e)).toBe('healing');
  });

  it('maps pending + not running to waiting', () => {
    const m = member({ ref: 1, landStatus: 'pending', state: null });
    const e = epic({ members: [m] });
    expect(memberRailStatus(m, e)).toBe('waiting');
  });

  it('maps pending + a non-running state (e.g. failed) to waiting, not healing, even with land in flight', () => {
    const m = member({ ref: 1, landStatus: 'pending', state: 'failed' });
    const e = epic({ members: [m], land: { inFlight: true, held: null } });
    expect(memberRailStatus(m, e)).toBe('waiting');
  });

  it('produces rail segments in member order', () => {
    const m1 = member({ ref: 3, landStatus: 'completed' });
    const m2 = member({ ref: 1, landStatus: 'blocked' });
    const m3 = member({ ref: 2, landStatus: 'pending', state: 'running' });
    const e = epic({ members: [m1, m2, m3] });
    expect(railSegments(e)).toEqual([
      { ref: 3, status: 'landed' },
      { ref: 1, status: 'blocking' },
      { ref: 2, status: 'running' },
    ]);
  });
});

describe('hasLiveHeal', () => {
  it('is false when no member is healing', () => {
    const m1 = member({ ref: 1, landStatus: 'completed' });
    const m2 = member({ ref: 2, landStatus: 'pending', state: 'running' });
    const e = epic({ members: [m1, m2], land: { inFlight: false, held: null } });
    expect(hasLiveHeal(e)).toBe(false);
  });

  it('is true when a running member coincides with an in-flight land', () => {
    const m1 = member({ ref: 1, landStatus: 'completed' });
    const m2 = member({ ref: 2, landStatus: 'pending', state: 'running' });
    const e = epic({ members: [m1, m2], land: { inFlight: true, held: null } });
    expect(hasLiveHeal(e)).toBe(true);
  });

  it('is false on an empty roster', () => {
    expect(hasLiveHeal(epic({ members: [], land: { inFlight: true, held: null } }))).toBe(false);
  });
});

describe('rosterLanes', () => {
  it('groups members into stuck/inflight/waiting/landed, preserving member order within each lane', () => {
    const blocked = member({ ref: 1, landStatus: 'blocked' });
    const running = member({ ref: 2, landStatus: 'pending', state: 'running' });
    const waiting = member({ ref: 3, landStatus: 'pending', state: null });
    const landed = member({ ref: 4, landStatus: 'completed' });
    const healing = member({ ref: 5, landStatus: 'pending', state: 'running' });
    const e = epic({
      members: [blocked, running, waiting, landed, healing],
      land: { inFlight: true, held: null },
    });
    const lanes = rosterLanes(e);
    expect(lanes.stuck).toEqual([blocked]);
    // running is upgraded to healing while the land is in flight, so both
    // running-state members land in the 'inflight' lane together.
    expect(lanes.inflight).toEqual([running, healing]);
    expect(lanes.waiting).toEqual([waiting]);
    expect(lanes.landed).toEqual([landed]);
  });

  it('always returns all four lane keys, even when empty', () => {
    const lanes = rosterLanes(epic({ members: [] }));
    expect(Object.keys(lanes).sort()).toEqual(['inflight', 'landed', 'stuck', 'waiting']);
    expect(lanes.stuck).toEqual([]);
    expect(lanes.inflight).toEqual([]);
    expect(lanes.waiting).toEqual([]);
    expect(lanes.landed).toEqual([]);
  });

  it('orders lanes stuck-first for display (ROSTER_LANES)', () => {
    expect(ROSTER_LANES).toEqual(['stuck', 'inflight', 'waiting', 'landed']);
  });
});

describe('statusLineParts', () => {
  it('renders tip, pass verification, and the fold count', () => {
    const m1 = member({ ref: 1, landStatus: 'completed' });
    const m2 = member({ ref: 2, landStatus: 'pending' });
    const e = epic({
      ref: 7,
      members: [m1, m2],
      integration: { branch: 'epic/7', exists: true, tip: 'abc1234' },
      verification: { status: 'pass' },
    });
    expect(statusLineParts(e)).toEqual({
      ref: 'epic/7',
      tip: 'abc1234',
      verification: '✓',
      foldedCount: 1,
      memberCount: 2,
    });
  });

  it('renders a dash tip when the branch is absent', () => {
    const e = epic({
      ref: 9,
      members: [],
      integration: { branch: 'epic/9', exists: false, tip: null },
      verification: { status: null },
    });
    expect(statusLineParts(e)).toEqual({
      ref: 'epic/9',
      tip: '—',
      verification: '—',
      foldedCount: 0,
      memberCount: 0,
    });
  });

  it('renders a fail verdict', () => {
    const e = epic({
      ref: 3,
      members: [],
      integration: { branch: 'epic/3', exists: true, tip: 'deadbee' },
      verification: { status: 'fail' },
    });
    expect(statusLineParts(e)).toEqual({
      ref: 'epic/3',
      tip: 'deadbee',
      verification: '✗',
      foldedCount: 0,
      memberCount: 0,
    });
  });

  it('renders a pending verdict the same as a null (unknown) one', () => {
    const pending = epic({
      ref: 4,
      members: [],
      integration: { branch: 'epic/4', exists: true, tip: 'cafefee' },
      verification: { status: 'pending' },
    });
    const unknown = epic({
      ref: 4,
      members: [],
      integration: { branch: 'epic/4', exists: true, tip: 'cafefee' },
      verification: { status: null },
    });
    expect(statusLineParts(pending)).toEqual({
      ref: 'epic/4',
      tip: 'cafefee',
      verification: '—',
      foldedCount: 0,
      memberCount: 0,
    });
    expect(statusLineParts(pending)).toEqual(statusLineParts(unknown));
  });
});

describe('epicByTaskId', () => {
  it('maps each member taskId to its owning Epic', () => {
    const m1 = member({ ref: 1, taskId: 101 });
    const m2 = member({ ref: 2, taskId: 102 });
    const e1 = epic({ ref: 10, members: [m1, m2] });
    const m3 = member({ ref: 3, taskId: 103 });
    const e2 = epic({ ref: 20, members: [m3] });
    const map = epicByTaskId([e1, e2]);
    expect(map.get(101)).toBe(e1);
    expect(map.get(102)).toBe(e1);
    expect(map.get(103)).toBe(e2);
    expect(map.size).toBe(3);
  });

  it('skips unmirrored members (taskId null)', () => {
    const mirrored = member({ ref: 1, taskId: 5 });
    const unmirrored = member({ ref: 2, taskId: null });
    const e = epic({ members: [mirrored, unmirrored] });
    const map = epicByTaskId([e]);
    expect(map.size).toBe(1);
    expect(map.get(5)).toBe(e);
  });

  it('returns an empty map for no epics', () => {
    expect(epicByTaskId([]).size).toBe(0);
  });
});

describe('landOutcomeBanner', () => {
  const cases: { outcome: EpicLandOutcome; tone: string; contains: string[] }[] = [
    { outcome: { status: 'landed', oid: 'abc123' }, tone: 'ok', contains: ['Merged', 'abc123'] },
    { outcome: { status: 'noop', reason: 'no integration branch' }, tone: 'info', contains: ['no integration branch'] },
    {
      outcome: { status: 'waiting', reason: 'default branch busy' },
      tone: 'warn',
      contains: ['default branch busy'],
    },
    {
      outcome: { status: 'blocked', reason: 'gate would not open' },
      tone: 'bad',
      contains: ['gate would not open'],
    },
    {
      outcome: { status: 'escalated', reason: 'verification failed' },
      tone: 'bad',
      contains: ['verification failed'],
    },
    { outcome: { status: 'busy' }, tone: 'warn', contains: ['already in flight'] },
  ];

  for (const { outcome, tone, contains } of cases) {
    it(`maps ${outcome.status} to tone ${tone}`, () => {
      const banner = landOutcomeBanner(outcome);
      expect(banner.tone).toBe(tone);
      for (const fragment of contains) expect(banner.text).toContain(fragment);
    });
  }

  it('produces a fixed sentence for busy (no reason field on the contract)', () => {
    expect(landOutcomeBanner({ status: 'busy' })).toEqual({
      tone: 'warn',
      text: 'A land for this Epic is already in flight — retry in a moment.',
    });
  });
});
