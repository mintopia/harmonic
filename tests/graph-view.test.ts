import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CardNode } from '../web/src/components/GraphView.js';
import type { Task } from '../web/src/types.js';

const task = (id: number, origin: Task['origin']): Task => ({
  id,
  prompt: 'Fix graph node layout',
  summary: 'Fix graph node layout',
  workspaceId: 1,
  harness: 'claude',
  model: 'claude-sonnet-4-6',
  workingDir: '/tmp',
  isolationMode: 'direct',
  priority: 'normal',
  baseBranch: null,
  conflictResolveTurns: 2,
  overrides: { harness: null, model: null, isolationMode: null, priority: null, conflictResolveTurns: null },
  state: 'ready',
  feedback: null,
  createdAt: 0,
  updatedAt: 0,
  dependsOn: [],
  dependents: [],
  blockedOnFailed: false,
  cost: null,
  origin,
  trackerRef: null,
  workflow: null,
  wayfinderType: null,
  escalationReason: null,
  openBlockerCount: 0,
  agentWorkable: true,
  humanOnly: false,
  isEpic: false,
  mapRef: null,
  url: null,
  mapTitle: null,
  branch: null,
  stat: null,
  runStartedAt: null,
  toolCount: null,
  attemptId: null,
  currentStep: null,
  contextTokens: null,
  contextWindow: null,
  verifiedRef: null,
  skipReason: null,
});

describe('CardNode', () => {
  const origins = [
    ['native', 'Native task'],
    ['mirrored', 'Mirrored task'],
  ] satisfies ReadonlyArray<readonly [Task['origin'], string]>;

  it.each(origins)('keeps the task ID clear for %s tasks', (origin, originLabel) => {
    const html = renderToStaticMarkup(
      createElement(CardNode, {
        n: { id: 325, task: task(325, origin), x: 0, y: 0, w: 196, h: 60 },
        task: task(325, origin),
        hovered: false,
        onHover: () => {},
        onActivate: () => {},
      }),
    );

    expect(html).toContain(`aria-label="Fix graph node layout — Ready, ${originLabel.toLowerCase()}, task 325. Open detail."`);
    expect(html).toContain(`<title>${originLabel}</title>`);
    expect(html).toContain('cx="142"');
    expect(html).toContain('x="182"');
    expect(html).toContain('>T-325<');
    expect(html.match(/<circle/g)).toHaveLength(2);
  });

  it('moves the origin marker left for a longer task ID while preserving the right edge', () => {
    const longTask = task(123456789, 'native');
    const html = renderToStaticMarkup(
      createElement(CardNode, {
        n: { id: longTask.id, task: longTask, x: 0, y: 0, w: 196, h: 60 },
        task: longTask,
        hovered: false,
        onHover: () => {},
        onActivate: () => {},
      }),
    );

    expect(html).toContain('cx="106"');
    expect(html).toContain('x="182"');
    expect(html).toContain('>T-123456789<');
  });
});
