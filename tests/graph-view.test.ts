import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CardNode } from '../web/src/components/GraphView.js';
import type { Task } from '../web/src/types.js';

const task = (id: number, origin: Task['origin'], trackerRef: number | null = null): Task => ({
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
  trackerRef,
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
  hasCandidate: false,
  skipReason: null,
});

describe('CardNode', () => {
  const origins = [
    ['native', 'Native task'],
    ['mirrored', 'Mirrored task'],
  ] satisfies ReadonlyArray<readonly [Task['origin'], string]>;

  const render = (t: Task) =>
    renderToStaticMarkup(
      createElement(CardNode, {
        n: { id: t.id, task: t, x: 0, y: 0, w: 196, h: 60 },
        task: t,
        hovered: false,
        onHover: () => {},
        onActivate: () => {},
      }),
    );

  it.each(origins)('names the origin in the label for %s tasks', (origin, originLabel) => {
    const html = render(task(325, origin));

    expect(html).toContain(`aria-label="Fix graph node layout — Ready, ${originLabel.toLowerCase()}, task 325. Open detail."`);
  });

  it('shows a native task by its task key alone, right-aligned', () => {
    const html = render(task(325, 'native'));

    expect(html).toContain('x="182"');
    expect(html).toContain('>T-325<');
  });

  it('shows a mirrored ticket by both ids, tracker ref first', () => {
    const html = render(task(325, 'mirrored', 436));

    expect(html).toContain('x="182"');
    expect(html).toContain('>#436 · T-325<');
  });

  it('keeps the id right-aligned for a longer id', () => {
    const html = render(task(123456789, 'native'));

    expect(html).toContain('x="182"');
    expect(html).toContain('>T-123456789<');
  });
});
