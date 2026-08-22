import { describe, expect, it } from 'vitest';
import { deriveEpicFrontier } from '../web/src/epic-frontier-model.js';
import type { Epic, EpicMember } from '../web/src/epic-model.js';
import type { Task, TaskState } from '../web/src/types.js';

const task = (id: number, state: TaskState, dependsOn: number[] = []): Task => ({
  id,
  prompt: `Task ${id}`,
  workspaceId: 1,
  harness: 'codex',
  model: 'gpt-5.6',
  workingDir: '/repo',
  isolationMode: 'worktree',
  priority: 'normal',
  baseBranch: null,
  overrides: { harness: null, model: null, isolationMode: null, priority: null },
  state,
  reattemptOf: null,
  feedback: null,
  createdAt: 0,
  updatedAt: 0,
  dependsOn,
  dependents: [],
  blockedOnFailed: false,
  reattempts: [],
  cost: null,
  origin: 'mirrored',
  trackerRef: id,
  workflow: 'implement',
  wayfinderType: null,
  drive: 'afk',
  escalated: false,
  mapRef: null,
  url: null,
  mapTitle: null,
  branch: null,
  stat: null,
  runStartedAt: null,
  toolCount: null,
  runId: null,
  candidateRef: null,
  skipReason: null,
});

const member = (ref: number, taskId: number, over: Partial<EpicMember> = {}): EpicMember => ({
  ref,
  title: `Member ${ref}`,
  taskId,
  state: null,
  escalated: false,
  landStatus: 'pending',
  ready: false,
  ...over,
});

const epic = (members: EpicMember[]): Epic => ({
  ref: 90,
  title: 'Epic',
  kind: 'spec',
  members,
  ready: members.filter((m) => m.ready).map((m) => m.ref),
  integration: { branch: 'epic/90', exists: true, tip: null },
  verification: { status: null },
  land: { inFlight: false, held: null },
  foldedCount: members.filter((m) => m.landStatus === 'completed').length,
  memberCount: members.length,
});

describe('deriveEpicFrontier (issue #264)', () => {
  it('puts ready and running visible members in Frontier, then layers blocked members by dependency depth', () => {
    const tasks = [task(1, 'ready'), task(2, 'running'), task(3, 'blocked', [1]), task(4, 'blocked', [3])];
    const model = deriveEpicFrontier(epic(tasks.map((t) => member(t.id, t.id))), tasks);

    expect(model.columns.map((column) => [column.label, column.nodes.map((node) => node.ref)])).toEqual([
      ['Frontier', [1, 2]],
      ['Depth 1', [3]],
      ['Depth 2', [4]],
    ]);
  });

  it('hides merged members while retaining their satisfied dependency chip', () => {
    const merged = task(1, 'completed');
    const blocked = task(2, 'blocked', [1, 99]);
    const model = deriveEpicFrontier(
      epic([member(1, 1, { landStatus: 'completed' }), member(2, 2)]),
      [merged, blocked],
    );

    expect(model.columns).toEqual([
      expect.objectContaining({ label: 'Depth 1', nodes: [expect.objectContaining({ ref: 2 })] }),
    ]);
    expect(model.columns[0]!.nodes[0]!.dependencies).toEqual([
      { taskId: 1, label: '#1', satisfied: true },
      { taskId: 99, label: 'Task 99', satisfied: false },
    ]);
  });

  it('keeps running work in Frontier without exposing Run now, and excludes HITL ready work from the action', () => {
    const running = task(1, 'running');
    const hitl = task(2, 'ready');
    hitl.drive = 'hitl';
    const model = deriveEpicFrontier(epic([member(1, 1), member(2, 2)]), [running, hitl]);

    expect(model.columns[0]).toMatchObject({
      label: 'Frontier',
      nodes: [
        { ref: 1, runnable: false },
        { ref: 2, runnable: false },
      ],
    });
  });

  it('uses the tracker-ready state for unmirrored members but never puts a member with open blockers in Frontier', () => {
    const readyWithBlocker = task(1, 'ready', [2]);
    const blocker = task(2, 'blocked');
    const model = deriveEpicFrontier(
      epic([
        member(1, 1, { ready: true }),
        member(2, 2),
        { ...member(3, 3, { ready: true }), taskId: null },
      ]),
      [readyWithBlocker, blocker],
    );

    expect(model.columns.map((column) => [column.label, column.nodes.map((node) => node.ref)])).toEqual([
      ['Frontier', [3]],
      ['Depth 1', [2]],
      ['Depth 2', [1]],
    ]);
    expect(model.columns[0]!.nodes[0]!.state).toBe('ready');
    expect(model.columns[2]!.nodes[0]!.runnable).toBe(false);
  });

  it('treats an absent dependency as satisfied once a member is ready', () => {
    const ready = task(2, 'ready', [1]);
    const model = deriveEpicFrontier(epic([member(2, 2)]), [ready]);

    expect(model.columns).toEqual([
      expect.objectContaining({
        label: 'Frontier',
        nodes: [
          expect.objectContaining({
            ref: 2,
            runnable: true,
            dependencies: [{ taskId: 1, label: 'Task 1', satisfied: true }],
          }),
        ],
      }),
    ]);
  });
});
