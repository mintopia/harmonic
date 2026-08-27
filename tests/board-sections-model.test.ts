import { describe, expect, it } from 'vitest';
import {
  blockerColumnLabel,
  blockerColumns,
  boardSections,
  cardTitle,
  epicPendingColumns,
  fmtElapsed,
  isActiveEpic,
  isEscalatedEpic,
  resolveBlockers,
  runningReadout,
  type PendingItem,
} from '../web/src/board-sections-model.js';
import type { Epic, EpicMember } from '../web/src/epic-model.js';
import type { Task, TaskState } from '../web/src/types.js';

const task = (id: number, state: TaskState, extra: Partial<Task> = {}): Task => ({
  id,
  prompt: `task ${id}`,
  summary: `task ${id}`,
  workspaceId: 1,
  harness: 'claude',
  model: 'claude-fable-5',
  workingDir: '/tmp',
  isolationMode: 'direct',
  priority: 'normal',
  baseBranch: null,
  integrationRetries: 5,
  conflictResolveTurns: 2,
  overrides: { harness: null, model: null, isolationMode: null, priority: null, integrationRetries: null, conflictResolveTurns: null },
  state,
  feedback: null,
  createdAt: 100,
  updatedAt: 100,
  dependsOn: [],
  dependents: [],
  blockedOnFailed: false,
  cost: null,
  origin: 'native',
  trackerRef: null,
  workflow: null,
  wayfinderType: null,
  escalationReason: null,
  openBlockerCount: 0,
  agentWorkable: true,
  humanOnly: false,
  mapRef: null,
  url: null,
  mapTitle: null,
  branch: null,
  stat: null,
  runStartedAt: null,
  toolCount: null,
  runId: null,
  phase: null,
  contextTokens: null,
  contextWindow: null,
  candidateRef: null,
  skipReason: null,
  ...extra,
});

/** A mirrored ticket blocked on `dependsOn`, with the API's derived count/flags as the server would send them. */
const blocked = (id: number, dependsOn: number[], extra: Partial<Task> = {}): Task =>
  task(id, 'ready', {
    origin: 'mirrored',
    trackerRef: id,
    dependsOn,
    openBlockerCount: dependsOn.length,
    agentWorkable: dependsOn.length === 0,
    ...extra,
  });

const member = (ref: number, taskId: number | null, extra: Partial<EpicMember> = {}): EpicMember => ({
  ref,
  title: `member ${ref}`,
  taskId,
  state: null,
  escalated: false,
  mergeStatus: 'pending',
  ready: false,
  ...extra,
});

const epic = (ref: number, members: EpicMember[], extra: Partial<Epic> = {}): Epic => ({
  ref,
  title: `epic ${ref}`,
  kind: 'spec',
  members,
  ready: [],
  integration: { branch: `epic/${ref}`, exists: true, tip: 'a1f9c02' },
  verification: { status: 'pending' },
  integrate: { inFlight: false, held: null },
  foldedCount: members.filter((entry) => entry.mergeStatus === 'completed').length,
  memberCount: members.length,
  ...extra,
});

const attentionIds = (sections: ReturnType<typeof boardSections>) =>
  sections.attention.map((entry) => (entry.kind === 'task' ? `task:${entry.task.id}` : `epic:${entry.epic.ref}`));

const layout = (columns: ReturnType<typeof blockerColumns>) =>
  columns.map((column) => [column.label, column.items.map((item) => item.label)]);

describe('boardSections — Attention / Running / Pending (ADR-0041)', () => {
  it('puts every escalated ticket in Attention (priority, then id) and every working ticket in Running, Epic members included', () => {
    const sections = boardSections(
      [
        task(1, 'escalated', { escalationReason: 'escalated to human: attempt 3 of 3 failed' }),
        task(2, 'escalated', { priority: 'high' }),
        task(3, 'working'),
        task(4, 'working'),
      ],
      [epic(30, [member(1, 4, { state: 'working' })])],
    );
    expect(attentionIds(sections)).toEqual(['task:2', 'task:1']);
    expect(sections.running.map((entry) => entry.id)).toEqual([3, 4]);
    // Nothing of Epic 30 is pending (its one member is Running), so it has no band.
    expect(sections.pending).toEqual([]);
  });

  it('skips a Pending band for an Epic whose members are all promoted or merged', () => {
    const sections = boardSections(
      [task(1, 'working'), task(2, 'done'), task(3, 'ready')],
      [
        epic(30, [member(301, 1, { state: 'working' }), member(302, 2, { mergeStatus: 'completed', state: 'done' })]),
        epic(31, [member(311, 3)]),
      ],
    );
    expect(sections.pending.map((group) => group.epic?.ref)).toEqual([31]);
  });

  it('surfaces an escalated Epic (held whole-Epic merge) in Attention after the escalated tickets', () => {
    const held = epic(60, [member(1, 601, { mergeStatus: 'completed', state: 'done' })], {
      integrate: { inFlight: false, held: 'already escalated for this member state; awaiting operator or a state change' },
    });
    const sections = boardSections([task(601, 'done'), task(7, 'escalated')], [held]);
    expect(isEscalatedEpic(held)).toBe(true);
    expect(isActiveEpic(held)).toBe(true);
    expect(attentionIds(sections)).toEqual(['task:7', 'epic:60']);
    // Its folded member is not pending work, so the Attention card is its only surface.
    expect(sections.pending).toEqual([]);
  });

  it('promotes an escalated Epic member to Attention and keeps it out of the band', () => {
    const sections = boardSections(
      [task(5, 'escalated'), task(6, 'ready')],
      [epic(40, [member(1, 5, { state: 'escalated', escalated: true }), member(2, 6)])],
    );
    expect(attentionIds(sections)).toEqual(['task:5']);
    expect(sections.running).toEqual([]);
    expect(layout(sections.pending[0]!.columns)).toEqual([['Frontier', ['T-6']]]);
  });

  it('keeps ready and draft tickets out of Attention — only escalated is the human surface', () => {
    const sections = boardSections([task(1, 'ready'), task(2, 'draft'), task(3, 'cancelled')], []);
    expect(sections.attention).toEqual([]);
    expect(sections.running).toEqual([]);
  });

  it('lays standalone Pending out by open-blocker count, ready before draft, and hides terminal tickets', () => {
    const sections = boardSections(
      [
        task(1, 'draft'),
        task(3, 'ready'),
        task(4, 'done'),
        task(5, 'cancelled'),
        blocked(6, [3]),
        blocked(7, [3, 1]),
        blocked(8, [3, 1, 2], { blockedOnFailed: true }),
      ],
      [],
    );
    expect(sections.pending).toHaveLength(1);
    expect(sections.pending[0]!.epic).toBeNull();
    expect(layout(sections.pending[0]!.columns)).toEqual([
      ['Frontier', ['T-3', 'T-1']],
      ['1 blocker', ['#6']],
      ['2 blockers', ['#7']],
      ['3 blockers', ['#8']],
    ]);
    const three = sections.pending[0]!.columns[3]!.items[0]!;
    expect(three.blockedOnFailed).toBe(true);
    expect(three.blockers).toEqual([
      { taskId: 3, label: 'T-3', satisfied: false },
      { taskId: 1, label: 'T-1', satisfied: false },
      { taskId: 2, label: 'Task 2', satisfied: false },
    ]);
  });

  it('groups Pending by Epic (ascending ref) with standalone last, and never renders an Epic driver ticket as a card', () => {
    const sections = boardSections(
      [task(9, 'ready', { trackerRef: 30 }), task(1, 'ready'), task(2, 'working'), task(3, 'ready'), task(4, 'ready')],
      [epic(31, [member(311, 4)]), epic(30, [member(301, 2, { state: 'working' }), member(302, 3)])],
    );
    expect(sections.pending.map((group) => group.epic?.ref ?? 'standalone')).toEqual([30, 31, 'standalone']);
    expect(layout(sections.pending[0]!.columns)).toEqual([['Frontier', ['T-3']]]);
    expect(layout(sections.pending[1]!.columns)).toEqual([['Frontier', ['T-4']]]);
    // The driver ticket (task 9) is neither pending nor running.
    expect(layout(sections.pending[2]!.columns)).toEqual([['Frontier', ['T-1']]]);
    expect(sections.running.map((entry) => entry.id)).toEqual([2]);
  });

  it('drops fully merged Epics and returns their members to standalone treatment', () => {
    const merged = epic(50, [member(1, 501, { mergeStatus: 'completed', state: 'done' })]);
    const sections = boardSections([task(501, 'ready')], [merged]);
    expect(isActiveEpic(merged)).toBe(false);
    expect(sections.pending).toEqual([{ epic: null, columns: [expect.objectContaining({ label: 'Frontier' })] }]);
    expect(sections.attention).toEqual([]);
    expect(sections.pending[0]!.columns[0]!.items.map((item) => item.taskId)).toEqual([501]);
  });

  it('keeps a human-only ticket in place in its blocker chain, muted rather than hidden', () => {
    const humanOnly = blocked(2, [1], { humanOnly: true });
    const downstream = blocked(3, [2]);
    const sections = boardSections([task(1, 'ready'), humanOnly, downstream], []);
    const items = sections.pending[0]!.columns.flatMap((column) => column.items);
    expect(items.map((item) => [item.label, item.humanOnly, item.runnable])).toEqual([
      ['T-1', false, true],
      ['#2', true, false],
      ['#3', false, false],
    ]);
  });
});

describe('epicPendingColumns', () => {
  it('hides merged members while retaining their satisfied dependency chip on a dependant', () => {
    const merged = task(1, 'done', { origin: 'mirrored', trackerRef: 1 });
    const dependant = blocked(2, [1, 99], { openBlockerCount: 1 });
    const columns = epicPendingColumns(epic(90, [member(1, 1, { mergeStatus: 'completed' }), member(2, 2)]), [merged, dependant]);
    expect(layout(columns)).toEqual([['1 blocker', ['#2']]]);
    expect(columns[0]!.items[0]!.blockers).toEqual([
      { taskId: 1, label: '#1', satisfied: true },
      { taskId: 99, label: 'Task 99', satisfied: false },
    ]);
  });

  it('excludes human-only ready work from Run now and promotes working members out of the band', () => {
    const working = task(1, 'working');
    const humanOnly = task(2, 'ready', { origin: 'mirrored', trackerRef: 2, agentWorkable: false, humanOnly: true });
    const columns = epicPendingColumns(epic(90, [member(1, 1), member(2, 2)]), [working, humanOnly]);
    expect(columns).toEqual([
      expect.objectContaining({
        label: 'Frontier',
        items: [expect.objectContaining({ label: '#2', runnable: false, humanOnly: true })],
      }),
    ]);
  });

  it('places an unmirrored member by its tracker-ready flag: Frontier when ready, an Unmirrored column otherwise', () => {
    const columns = epicPendingColumns(
      epic(90, [member(1, null, { ready: true }), member(2, null), member(3, 3)]),
      [blocked(3, [1])],
    );
    expect(layout(columns)).toEqual([
      ['Frontier', ['#1']],
      ['1 blocker', ['#3']],
      ['Unmirrored', ['#2']],
    ]);
    expect(columns[0]!.items[0]).toMatchObject({ state: 'ready', taskId: null, runnable: false });
    expect(columns[2]!.items[0]).toMatchObject({ state: null, openBlockerCount: null });
  });

  it('hides a done-but-unfolded member — it is no longer pending work', () => {
    const columns = epicPendingColumns(epic(90, [member(1, 1), member(2, 2)]), [task(1, 'done'), task(2, 'ready')]);
    expect(layout(columns)).toEqual([['Frontier', ['T-2']]]);
  });
});

describe('blocker columns', () => {
  it('labels columns by open-blocker count with Frontier first and Unmirrored last', () => {
    expect([0, 1, 2, null].map(blockerColumnLabel)).toEqual(['Frontier', '1 blocker', '2 blockers', 'Unmirrored']);
    const item = (key: string, openBlockerCount: number | null): PendingItem => ({
      key,
      taskId: null,
      label: key,
      title: key,
      state: null,
      openBlockerCount,
      blockedOnFailed: false,
      humanOnly: false,
      runnable: false,
      blockers: [],
    });
    expect(layout(blockerColumns([item('u', null), item('b', 2), item('a', 0), item('c', 2)]))).toEqual([
      ['Frontier', ['a']],
      ['2 blockers', ['b', 'c']],
      ['Unmirrored', ['u']],
    ]);
  });

  it('resolves a visible blocker as satisfied only when it is done — a cancelled blocker still counts, as on the server', () => {
    const tasks = new Map([task(1, 'done'), task(2, 'cancelled')].map((t) => [t.id, t]));
    // Server-consistent: blockers 2 (cancelled) and 4 (absent) are the two
    // non-done edges, so openBlockerCount is 2 and blockedOnFailed is set.
    const dependant = task(3, 'ready', { dependsOn: [1, 2, 4], openBlockerCount: 2, blockedOnFailed: true });
    expect(resolveBlockers(dependant, tasks)).toEqual([
      { taskId: 1, label: 'T-1', satisfied: true },
      { taskId: 2, label: 'T-2', satisfied: false },
      { taskId: 4, label: 'Task 4', satisfied: false },
    ]);
  });

  it('reads satisfied from openBlockerCount when the done blocker is off the lean page (ADR-0045)', () => {
    // The Board now fetches an open-only page, so a done blocker is absent from
    // the array. openBlockerCount === 0 means every edge is cleared, so the
    // chip strikes through even though its blocker task is not in the map.
    const cleared = task(9, 'ready', { dependsOn: [1, 2], openBlockerCount: 0 });
    expect(resolveBlockers(cleared, new Map())).toEqual([
      { taskId: 1, label: 'Task 1', satisfied: true },
      { taskId: 2, label: 'Task 2', satisfied: true },
    ]);
    // With an open blocker still outstanding, an absent edge we cannot prove
    // done stays unsatisfied rather than falsely clearing.
    const partly = task(10, 'ready', { dependsOn: [1, 2], openBlockerCount: 1 });
    expect(resolveBlockers(partly, new Map()).map((b) => b.satisfied)).toEqual([false, false]);
  });
});

describe('live Board readouts', () => {
  it('formats elapsed time and uses the freshest tool count', () => {
    expect(fmtElapsed(3_725_000)).toBe('1h 2m');
    expect(runningReadout(task(1, 'working', { runStartedAt: 1_000, toolCount: 3 }), 2_000, 7)).toEqual({ elapsed: '1s', tools: 7 });
  });

  it('returns no readout without a started working task', () => {
    expect(runningReadout(task(1, 'ready', { runStartedAt: 1_000 }), 2_000)).toBeNull();
    expect(runningReadout(task(1, 'working'), 2_000)).toBeNull();
  });
});

describe('cardTitle', () => {
  it('cuts an inline Markdown heading off the summary', () => {
    expect(cardTitle('Running run is invisible ## Summary A run row...')).toBe('Running run is invisible');
  });

  it('strips a leading heading marker', () => {
    expect(cardTitle('## What to build\n\nbody text')).toBe('What to build');
  });

  it('takes the first non-empty line and trims it', () => {
    expect(cardTitle('\n  Fix the flaky test  \nmore detail')).toBe('Fix the flaky test');
  });

  it('passes a plain one-line prompt through', () => {
    expect(cardTitle('Add compact conversation formatter')).toBe('Add compact conversation formatter');
  });
});
