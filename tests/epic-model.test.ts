import { describe, expect, it } from 'vitest';
import {
  closedMembers,
  epicByTaskId,
  integrateOutcomeBanner,
  integrationSteps,
  isEpicIntegrating,
  memberPipStatus,
  statusLineParts,
} from '../web/src/epic-model.js';
import type { Epic, EpicIntegrateOutcome, EpicMember } from '../web/src/epic-model.js';

const member = (overrides: Partial<EpicMember> & { ref: number }): EpicMember => ({
  title: `member ${overrides.ref}`,
  taskId: overrides.ref,
  state: null,
  escalated: false,
  mergeStatus: 'pending',
  ready: false,
  ...overrides,
});

const epic = (overrides: Partial<Epic> = {}): Epic => {
  const members = overrides.members ?? [];
  return {
    ref: 1,
    title: 'epic 1',
    kind: 'map',
    description: '',
    createdAt: 0,
    updatedAt: null,
    baseBranch: null,
    dependsOn: [],
    members,
    ready: [],
    integration: { branch: 'epic/1', exists: true, tip: null },
    verification: { status: null },
    integrate: { inFlight: false, held: null },
    foldedCount: members.filter((m) => m.mergeStatus === 'completed').length,
    memberCount: members.length,
    ...overrides,
  };
};


describe('statusLineParts', () => {
  it('renders tip, pass verification, and the fold count', () => {
    const m1 = member({ ref: 1, mergeStatus: 'completed' });
    const m2 = member({ ref: 2, mergeStatus: 'pending' });
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

describe('integrateOutcomeBanner', () => {
  const cases: { outcome: EpicIntegrateOutcome; tone: string; contains: string[] }[] = [
    { outcome: { status: 'integrated', oid: 'abc123' }, tone: 'ok', contains: ['Integrated', 'abc123'] },
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
      const banner = integrateOutcomeBanner(outcome);
      expect(banner.tone).toBe(tone);
      for (const fragment of contains) expect(banner.text).toContain(fragment);
    });
  }

  it('produces a fixed sentence for busy (no reason field on the contract)', () => {
    expect(integrateOutcomeBanner({ status: 'busy' })).toEqual({
      tone: 'warn',
      text: 'An integration for this Epic is already in flight — retry in a moment.',
    });
  });
});

describe('memberPipStatus', () => {
  it('maps escalated to escalated', () => {
    const m = member({ ref: 1, escalated: true });
    expect(memberPipStatus(m)).toBe('escalated');
  });

  it('maps mergeStatus blocked to blocked', () => {
    const m = member({ ref: 1, mergeStatus: 'blocked' });
    expect(memberPipStatus(m)).toBe('blocked');
  });

  it('maps mergeStatus completed to merged', () => {
    const m = member({ ref: 1, mergeStatus: 'completed' });
    expect(memberPipStatus(m)).toBe('merged');
  });

  it('maps state cancelled to cancelled', () => {
    const m = member({ ref: 1, state: 'cancelled' });
    expect(memberPipStatus(m)).toBe('cancelled');
  });

  it('maps state working to running', () => {
    const m = member({ ref: 1, state: 'working' });
    expect(memberPipStatus(m)).toBe('running');
  });

  it('maps state running to running', () => {
    const m = member({ ref: 1, state: 'running' });
    expect(memberPipStatus(m)).toBe('running');
  });

  it('maps a ready-frontier member (pending, not running) to ready', () => {
    const m = member({ ref: 1, state: null, mergeStatus: 'pending', ready: true });
    expect(memberPipStatus(m)).toBe('ready');
  });

  it('running outranks ready', () => {
    const m = member({ ref: 1, state: 'running', ready: true });
    expect(memberPipStatus(m)).toBe('running');
  });

  it('merged outranks ready (a completed member is never a ready pip)', () => {
    const m = member({ ref: 1, mergeStatus: 'completed', ready: true });
    expect(memberPipStatus(m)).toBe('merged');
  });

  it('maps state null, mergeStatus pending, not ready to waiting', () => {
    const m = member({ ref: 1, state: null, mergeStatus: 'pending' });
    expect(memberPipStatus(m)).toBe('waiting');
  });

  it('escalation outranks blocked', () => {
    const m = member({ ref: 1, escalated: true, mergeStatus: 'blocked' });
    expect(memberPipStatus(m)).toBe('escalated');
  });
});

describe('closedMembers', () => {
  it('filters to completed/cancelled/done members, excludes pending/running, preserves order', () => {
    const completed = member({ ref: 1, mergeStatus: 'completed' });
    const cancelled = member({ ref: 2, mergeStatus: 'pending', state: 'cancelled' });
    const done = member({ ref: 3, mergeStatus: 'pending', state: 'done' });
    const running = member({ ref: 4, mergeStatus: 'pending', state: 'running' });
    const e = epic({ members: [completed, cancelled, done, running] });
    expect(closedMembers(e)).toEqual([completed, cancelled, done]);
  });
});

describe('isEpicIntegrating', () => {
  it('is true when every member is folded', () => {
    const m1 = member({ ref: 1, mergeStatus: 'completed' });
    const m2 = member({ ref: 2, mergeStatus: 'completed' });
    const e = epic({ members: [m1, m2] });
    expect(isEpicIntegrating(e)).toBe(true);
  });

  it('is true when an integrate is in flight', () => {
    const m1 = member({ ref: 1, mergeStatus: 'pending' });
    const e = epic({ members: [m1], integrate: { inFlight: true, held: null } });
    expect(isEpicIntegrating(e)).toBe(true);
  });

  it('is true when an integrate is held', () => {
    const m1 = member({ ref: 1, mergeStatus: 'pending' });
    const e = epic({ members: [m1], integrate: { inFlight: false, held: 'verification failed' } });
    expect(isEpicIntegrating(e)).toBe(true);
  });

  it('is false for an epic with pending members, not in flight, not held', () => {
    const m1 = member({ ref: 1, mergeStatus: 'completed' });
    const m2 = member({ ref: 2, mergeStatus: 'pending' });
    const e = epic({ members: [m1, m2], integrate: { inFlight: false, held: null } });
    expect(isEpicIntegrating(e)).toBe(false);
  });

  it('is false for an empty roster with nothing in flight/held', () => {
    const e = epic({ members: [], integrate: { inFlight: false, held: null } });
    expect(isEpicIntegrating(e)).toBe(false);
  });
});

describe('integrationSteps', () => {
  it('when not verified, verify is current and merge/check/retire are pending', () => {
    const e = epic({ members: [], verification: { status: 'pending' } });
    const steps = integrationSteps(e);
    expect(steps.map((s) => s.key)).toEqual(['verify', 'merge', 'check', 'retire']);
    expect(steps).toEqual([
      { key: 'verify', label: 'Verify', state: 'current' },
      { key: 'merge', label: 'Merge', state: 'pending' },
      { key: 'check', label: 'Post-merge check', state: 'pending' },
      { key: 'retire', label: 'Retire', state: 'pending' },
    ]);
  });

  it('when verified and not held, verify is done and merge is current', () => {
    const e = epic({ members: [], verification: { status: 'pass' }, integrate: { inFlight: false, held: null } });
    const steps = integrationSteps(e);
    expect(steps).toEqual([
      { key: 'verify', label: 'Verify', state: 'done' },
      { key: 'merge', label: 'Merge', state: 'current' },
      { key: 'check', label: 'Post-merge check', state: 'pending' },
      { key: 'retire', label: 'Retire', state: 'pending' },
    ]);
  });

  it('when verified and held, merge state is held', () => {
    const e = epic({
      members: [],
      verification: { status: 'pass' },
      integrate: { inFlight: false, held: 'escalated' },
    });
    const steps = integrationSteps(e);
    expect(steps.find((s) => s.key === 'merge')?.state).toBe('held');
  });

  it('when not verified and held, verify state is held', () => {
    const e = epic({
      members: [],
      verification: { status: 'pending' },
      integrate: { inFlight: false, held: 'escalated' },
    });
    const steps = integrationSteps(e);
    expect(steps.find((s) => s.key === 'verify')?.state).toBe('held');
  });
});
