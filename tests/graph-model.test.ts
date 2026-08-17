import { describe, expect, it } from 'vitest';
import {
  graphEdges,
  isTerminalState,
  mapBadges,
  nodeTitle,
  visibleTasks,
  type GraphEdge,
} from '../web/src/graph-model.js';
import type { Task, TaskState } from '../web/src/types.js';

/** A Task fixture — only the fields the Graph reads matter; the rest are the
 * same neutral defaults board-model.test.ts uses. */
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
  overrides: { harness: null, model: null, isolationMode: null, priority: null },
  state,
  reattemptOf: null,
  feedback: null,
  createdAt: id,
  updatedAt: id,
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
  ...extra,
});

describe('terminal-state visibility', () => {
  it('treats completed / failed / cancelled as terminal, everything else active', () => {
    for (const s of ['completed', 'failed', 'cancelled'] as TaskState[]) {
      expect(isTerminalState(s)).toBe(true);
    }
    for (const s of ['draft', 'blocked', 'ready', 'running', 'awaiting-review'] as TaskState[]) {
      expect(isTerminalState(s)).toBe(false);
    }
  });

  it('shows only active-state Tasks by default', () => {
    const tasks = [task(1, 'running'), task(2, 'completed'), task(3, 'cancelled'), task(4, 'ready')];
    expect(visibleTasks(tasks, false).map((t) => t.id)).toEqual([1, 4]);
  });

  it('reveals terminal Tasks when the toggle is on, preserving order', () => {
    const tasks = [task(1, 'running'), task(2, 'completed'), task(4, 'ready')];
    expect(visibleTasks(tasks, true).map((t) => t.id)).toEqual([1, 2, 4]);
  });
});

describe('dependency edges', () => {
  it('derives one directed edge per dependsOn (prerequisite → dependent)', () => {
    const tasks = [task(1, 'completed'), task(2, 'ready', { dependsOn: [1] })];
    expect(graphEdges(tasks)).toEqual<GraphEdge[]>([{ from: 1, to: 2 }]);
  });

  it('unifies native and mirrored Tasks over the same relation', () => {
    const tasks = [
      task(1, 'completed', { origin: 'mirrored', trackerRef: 10 }),
      task(2, 'ready', { origin: 'native', dependsOn: [1] }),
    ];
    expect(graphEdges(tasks)).toEqual<GraphEdge[]>([{ from: 1, to: 2 }]);
  });

  it('drops edges whose other endpoint is hidden, so nothing dangles', () => {
    // 2 depends on 1, but 1 (completed) is filtered out when terminal is hidden.
    const all = [task(1, 'completed'), task(2, 'ready', { dependsOn: [1] })];
    const visible = visibleTasks(all, false);
    expect(graphEdges(visible)).toEqual([]);
  });

  it('ignores self-references and de-duplicates', () => {
    const tasks = [
      task(1, 'ready'),
      // A malformed self-dep and a doubled dep must not produce phantom edges.
      task(2, 'ready', { dependsOn: [1, 1, 2] }),
    ];
    expect(graphEdges(tasks)).toEqual<GraphEdge[]>([{ from: 1, to: 2 }]);
  });
});

describe('node title', () => {
  it('reads the first non-empty line of the prompt', () => {
    expect(nodeTitle('Build the graph view\n\nmore detail')).toBe('Build the graph view');
    expect(nodeTitle('\n  \n  Indented first line  ')).toBe('Indented first line');
  });

  it('falls back for an empty prompt', () => {
    expect(nodeTitle('   ')).toBe('Untitled task');
  });
});

describe('map badges', () => {
  it('numbers the Maps present, 1-based, in ascending mapRef order', () => {
    const tasks = [
      task(1, 'ready', { mapRef: 52, mapTitle: 'Activity' }),
      task(2, 'ready', { mapRef: 30, mapTitle: 'Mirroring' }),
      task(3, 'ready', { mapRef: 52, mapTitle: 'Activity' }),
      task(4, 'ready'), // unmapped — no badge
    ];
    const badges = mapBadges(tasks);
    expect(badges.get(30)).toBe(1);
    expect(badges.get(52)).toBe(2);
    expect(badges.size).toBe(2);
  });
});
