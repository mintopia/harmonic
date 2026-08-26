import { describe, expect, it } from 'vitest';
import { boardSections, cardTitle, fmtElapsed, isActiveEpic, runningReadout } from '../web/src/board-sections-model.js';
import type { Epic, EpicMember } from '../web/src/epic-model.js';
import type { Task, TaskState } from '../web/src/types.js';

const task = (id: number, state: TaskState, extra: Partial<Task> = {}): Task => ({
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

const epic = (ref: number, members: EpicMember[], extra: Partial<Epic> = {}): Epic => ({
  ref,
  title: `epic ${ref}`,
  kind: 'spec',
  members,
  ready: [],
  integration: { branch: `epic/${ref}`, exists: true, tip: 'a1f9c02' },
  verification: { status: 'pending' },
  land: { inFlight: false, held: null },
  foldedCount: members.filter((entry) => entry.landStatus === 'completed').length,
  memberCount: members.length,
  ...extra,
});

describe('boardSections', () => {
  it('puts every escalated ticket in Needs you (priority, then id) and promotes a working Epic member to Active', () => {
    const sections = boardSections(
      [
        task(1, 'escalated', { escalationReason: 'escalated to human: attempt 3 of 3 failed' }),
        task(2, 'escalated', { priority: 'high' }),
        task(3, 'working'),
        task(4, 'working'),
      ],
      [epic(30, [member(1, 4, { state: 'working' })])],
    );
    expect(sections.needsYou.map((entry) => entry.id)).toEqual([2, 1]);
    // Task 4 is a working Epic member — surfaced in Active alongside standalone 3.
    expect(sections.active.map((entry) => entry.id)).toEqual([3, 4]);
    expect(sections.epics.map((entry) => entry.ref)).toEqual([30]);
  });

  it('promotes an escalated Epic member to Needs you, out of Active and the band', () => {
    const sections = boardSections(
      [task(5, 'escalated')],
      [epic(40, [member(1, 5, { state: 'escalated', escalated: true })])],
    );
    expect(sections.needsYou.map((entry) => entry.id)).toEqual([5]);
    expect(sections.active.map((entry) => entry.id)).toEqual([]);
    expect(sections.epics.map((entry) => entry.ref)).toEqual([40]);
  });

  it('keeps a ready ticket out of Needs you — only the escalated state is the human surface', () => {
    const sections = boardSections([task(1, 'ready'), task(2, 'draft'), task(3, 'cancelled')], []);
    expect(sections.needsYou).toEqual([]);
  });

  it('orders standalone ready work before draft and excludes terminal tasks', () => {
    const sections = boardSections([task(1, 'draft'), task(3, 'ready'), task(4, 'done'), task(5, 'cancelled')], []);
    expect(sections.standalone.map((entry) => entry.id)).toEqual([3, 1]);
  });

  it("excludes an Epic's own driver ticket (trackerRef === epic.ref) from the flat sections", () => {
    const sections = boardSections(
      [task(9, 'ready', { trackerRef: 30 }), task(1, 'ready'), task(2, 'working')],
      [epic(30, [member(31, 2, { state: 'working' })])],
    );
    expect(sections.standalone.map((entry) => entry.id)).toEqual([1]);
    // The driver ticket (task 9) is neither standalone nor Active; its working
    // member (task 2) is promoted to Active.
    expect(sections.active.map((entry) => entry.id)).toEqual([2]);
    expect(sections.epics.map((entry) => entry.ref)).toEqual([30]);
  });

  it('drops fully merged Epics and returns their members to standalone treatment', () => {
    const merged = epic(50, [member(1, 501, { landStatus: 'completed', state: 'done' })]);
    const sections = boardSections([task(501, 'ready')], [merged]);
    expect(sections.epics).toEqual([]);
    expect(sections.standalone.map((entry) => entry.id)).toEqual([501]);
    expect(isActiveEpic(merged)).toBe(false);
  });

  it('keeps a fully-folded Epic whose merge escalated (land.held) on the board', () => {
    const held = epic(60, [member(1, 601, { landStatus: 'completed', state: 'done' })], {
      land: { inFlight: false, held: 'already escalated for this member state; awaiting operator or a state change' },
    });
    const sections = boardSections([task(601, 'done')], [held]);
    expect(isActiveEpic(held)).toBe(true);
    // The Epic stays in the active/Landing section, not dropped off the board.
    expect(sections.epics.map((entry) => entry.ref)).toEqual([60]);
    // Its folded member stays the Epic band's, excluded from the flat sections.
    expect(sections.standalone.map((entry) => entry.id)).toEqual([]);
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
