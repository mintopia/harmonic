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
  feedback: null,
  createdAt: 0,
  updatedAt: 0,
  dependsOn,
  dependents: [],
  blockedOnFailed: false,
  cost: null,
  origin: 'mirrored',
  trackerRef: id,
  workflow: 'implement',
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
  it('puts ready members in Frontier and layers blocked members by depth (working members are promoted out)', () => {
    const tasks = [task(1, 'ready'), task(2, 'working'), task(3, 'ready', [1]), task(4, 'ready', [3])];
    const model = deriveEpicFrontier(epic(tasks.map((t) => member(t.id, t.id))), tasks);

    // The working member (2) is surfaced in the Board's Active section, not here.
    expect(model.columns.map((column) => [column.label, column.nodes.map((node) => node.ref)])).toEqual([
      ['Frontier', [1]],
      ['Depth 1', [3]],
      ['Depth 2', [4]],
    ]);
  });

  it('hides merged members while retaining their satisfied dependency chip', () => {
    const merged = task(1, 'done');
    const blocked = task(2, 'ready', [1, 99]);
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

  it('promotes working members out of the band and excludes human-only ready work from Run now', () => {
    const working = task(1, 'working');
    const humanOnly = task(2, 'ready');
    humanOnly.agentWorkable = false;
    const model = deriveEpicFrontier(epic([member(1, 1), member(2, 2)]), [working, humanOnly]);

    // Working member (1) is promoted to Active; only the human-only ready
    // member remains, and it is not runnable.
    expect(model.columns[0]).toMatchObject({
      label: 'Frontier',
      nodes: [{ ref: 2, runnable: false }],
    });
  });

  it('uses the tracker-ready state for unmirrored members but never puts a member with open blockers in Frontier', () => {
    const readyWithBlocker = task(1, 'ready', [2]);
    const blocker = task(2, 'ready', [99]);
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

  it('keeps a completed standalone dependency satisfied in the frontier', () => {
    const ready = task(2, 'ready', [1]);
    const completed = task(1, 'done');
    const model = deriveEpicFrontier(epic([member(2, 2)]), [completed, ready]);

    expect(model.columns).toEqual([
      expect.objectContaining({
        label: 'Frontier',
        nodes: [
          expect.objectContaining({
            ref: 2,
            runnable: true,
            dependencies: [{ taskId: 1, label: '#1', satisfied: true }],
          }),
        ],
      }),
    ]);
  });
});
