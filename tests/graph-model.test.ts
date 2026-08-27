import { describe, expect, it } from 'vitest';
import {
  SIGNAL,
  STATE_LABEL,
  edgePath,
  fitTransform,
  graphEdges,
  isTerminalState,
  mapBadges,
  nodeTitle,
  port,
  truncate,
  visibleTasks,
  type GraphEdge,
} from '../web/src/graph-model.js';
import { TASK_STATES, type Task, type TaskState } from '../web/src/types.js';

/** A Task fixture — only the fields the Graph reads matter; the rest are the
 * same neutral defaults board-model.test.ts uses. */
const task = (
  id: number,
  state: TaskState,
  extra: Partial<Task> = {},
): Task => ({
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
  createdAt: id,
  updatedAt: id,
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

describe('terminal-state visibility', () => {
  it('treats done / cancelled as terminal, everything else active (escalated waits on a human, it is not over)', () => {
    for (const s of ['done', 'cancelled'] as TaskState[]) {
      expect(isTerminalState(s)).toBe(true);
    }
    for (const s of ['draft', 'ready', 'working', 'escalated'] as TaskState[]) {
      expect(isTerminalState(s)).toBe(false);
    }
  });

  it('shows only active-state Tasks by default', () => {
    const tasks = [task(1, 'working'), task(2, 'done'), task(3, 'cancelled'), task(4, 'ready')];
    expect(visibleTasks(tasks, false).map((t) => t.id)).toEqual([1, 4]);
  });

  it('keeps a cancelled blocker that still gates an active Task, but hides a satisfied one', () => {
    // 1 (cancelled) still blocks 2 → kept so the block is visible; 3 (done)
    // is satisfied → stays hidden. Matches the domain: unblock only on `done`.
    const tasks = [
      task(1, 'cancelled'),
      task(2, 'ready', { dependsOn: [1] }),
      task(3, 'done'),
      task(4, 'ready', { dependsOn: [3] }),
    ];
    expect(visibleTasks(tasks, false).map((t) => t.id)).toEqual([1, 2, 4]);
  });

  it('hides a terminal Task that blocks nothing active', () => {
    // 1 (cancelled) only blocks a terminal dependent, so it explains no live block.
    const tasks = [task(1, 'cancelled'), task(2, 'done', { dependsOn: [1] })];
    expect(visibleTasks(tasks, false).map((t) => t.id)).toEqual([]);
  });

  it('reveals terminal Tasks when the toggle is on, preserving order', () => {
    const tasks = [task(1, 'working'), task(2, 'done'), task(4, 'ready')];
    expect(visibleTasks(tasks, true).map((t) => t.id)).toEqual([1, 2, 4]);
  });
});

describe('dependency edges', () => {
  it('derives one directed edge per dependsOn (prerequisite → dependent)', () => {
    const tasks = [task(1, 'done'), task(2, 'ready', { dependsOn: [1] })];
    expect(graphEdges(tasks)).toEqual<GraphEdge[]>([{ from: 1, to: 2 }]);
  });

  it('unifies native and mirrored Tasks over the same relation', () => {
    const tasks = [
      task(1, 'done', { origin: 'mirrored', trackerRef: 10 }),
      task(2, 'ready', { origin: 'native', dependsOn: [1] }),
    ];
    expect(graphEdges(tasks)).toEqual<GraphEdge[]>([{ from: 1, to: 2 }]);
  });

  it('drops edges whose other endpoint is hidden, so nothing dangles', () => {
    // 2 depends on 1, but 1 (completed) is filtered out when terminal is hidden.
    const all = [task(1, 'done'), task(2, 'ready', { dependsOn: [1] })];
    const visible = visibleTasks(all, false);
    expect(graphEdges(visible)).toEqual([]);
  });

  it('keeps the blocking edge from a cancelled/failed blocker to an active dependent', () => {
    // Regression: a cancelled blocker keeps its dependent blocked by the edge, so the
    // graph must still draw the edge rather than hiding the blocker and reading unblocked.
    const all = [task(1, 'cancelled'), task(2, 'ready', { dependsOn: [1] })];
    const visible = visibleTasks(all, false);
    expect(graphEdges(visible)).toEqual<GraphEdge[]>([{ from: 1, to: 2 }]);
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

describe('state-signal palette (the Signal Rule)', () => {
  it('maps every task state to a signal colour and a label', () => {
    for (const s of TASK_STATES) {
      expect(SIGNAL[s]).toBeDefined();
      expect(SIGNAL[s].color).toMatch(/^var\(--hm-/);
      expect(SIGNAL[s].text).toMatch(/^var\(--hm-/);
      expect(STATE_LABEL[s]).toBeTruthy();
    }
  });

  it('keeps draft and cancelled neutral — only true states carry a hue', () => {
    // The Signal Rule: nothing-happening (draft) and it's-over (cancelled) get
    // no state colour, just the neutral Faint dot / Muted text.
    const neutral = { color: 'var(--hm-faint)', text: 'var(--hm-muted)' };
    expect(SIGNAL.draft).toEqual(neutral);
    expect(SIGNAL.cancelled).toEqual(neutral);

    // Every live state reads as something other than the neutral pair.
    for (const s of ['ready', 'working', 'escalated', 'done'] as TaskState[]) {
      expect(SIGNAL[s]).not.toEqual(neutral);
    }
  });

  it('speaks escalated in the indigo needs-you voice', () => {
    expect(SIGNAL.escalated).toEqual({ color: 'var(--hm-await-dot)', text: 'var(--hm-await)' });
  });
});

describe('truncate', () => {
  it('leaves a short string untouched and ellipsises a long one', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('a very long title indeed', 10)).toBe('a very lo…');
    expect(truncate('a very long title indeed', 10)).toHaveLength(10);
  });
});

describe('fitTransform', () => {
  it('returns the identity transform for a degenerate box or viewport', () => {
    expect(fitTransform(0, 100, 800, 600)).toEqual({ k: 1, tx: 0, ty: 0 });
    expect(fitTransform(100, 100, 0, 600)).toEqual({ k: 1, tx: 0, ty: 0 });
  });

  it('scales a large graph down to fit inside the padded viewport', () => {
    const t = fitTransform(2000, 2000, 800, 600);
    // Fits within the 48px padding on the tighter (height) axis.
    expect(t.k).toBeCloseTo((600 - 96) / 2000, 5);
    expect(t.k).toBeLessThan(1);
  });

  it('caps the zoom at 1.5× so a tiny graph does not balloon, and centres it', () => {
    const t = fitTransform(100, 100, 800, 600);
    expect(t.k).toBe(1.5);
    // Centred: equal margin either side of the scaled content.
    expect(t.tx).toBeCloseTo((800 - 100 * 1.5) / 2, 5);
    expect(t.ty).toBeCloseTo((600 - 100 * 1.5) / 2, 5);
  });
});

describe('edge geometry', () => {
  const box = (x: number, y: number) => ({ x, y, w: 100, h: 40 });

  it('ports out of the trailing edge and into the leading edge (L→R flow)', () => {
    const n = box(10, 20);
    expect(port(n, 'out')).toEqual({ x: 110, y: 40 }); // right-centre
    expect(port(n, 'in')).toEqual({ x: 10, y: 40 }); // left-centre
  });

  it('draws a cubic bezier from source out-port to target in-port', () => {
    const a = box(0, 0);
    const b = box(200, 100);
    // out(a) = (100, 20), in(b) = (200, 120), mid-x = 150.
    expect(edgePath(a, b)).toBe('M100,20 C150,20 150,120 200,120');
  });
});
