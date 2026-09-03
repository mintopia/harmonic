// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EpicAttentionCard } from '../web/src/components/Board.js';
import { EpicStepper } from '../web/src/components/EpicPage.js';
import { epicLifecycleSteps } from '../web/src/epic-model.js';
import type { Epic } from '../web/src/epic-model.js';

function epic(overrides: Partial<Epic> = {}): Epic {
  return {
    ref: 424,
    title: 'Held whole-Epic integration',
    kind: 'spec',
    state: 'open',
    description: '',
    createdAt: 0,
    updatedAt: 0,
    baseBranch: 'develop',
    dependsOn: [],
    members: [],
    ready: [],
    integration: { branch: 'epic/424', exists: true, tip: 'abc123' },
    verification: { status: 'pass', configured: true },
    integrate: { inFlight: false, held: 'awaiting operator decision' },
    mergeSteps: [],
    foldedCount: 2,
    memberCount: 2,
    ...overrides,
  };
}

describe('Epic integrate.held surfacing', () => {
  it("renders the held Epic as an escalated (indigo) card in the Board's Attention section", () => {
    const html = renderToStaticMarkup(createElement(EpicAttentionCard, { epic: epic() }));

    expect(html).toContain('escalated');
    expect(html).toContain('bg-await-dot');
    expect(html).toContain('awaiting operator decision');
  });

  it('projects a held whole-Epic merge onto the lifecycle steps as "held — <reason>" (ADR-0017)', () => {
    const steps = epicLifecycleSteps(epic());
    const merge = steps.find((s) => s.key === 'merge');

    expect(merge?.state).toBe('held');
    expect(merge?.sublabel.startsWith('held — ')).toBe(true);
  });

  it('surfaces a held whole-Epic merge on the summary-page stepper, not a force-merge button (ADR-0017)', () => {
    const html = renderToStaticMarkup(createElement(EpicStepper, { epic: epic() }));

    expect(html).toContain('held — awaiting operator decision');
    expect(html).toContain('aria-current="step"');
    expect(html).not.toContain('Force-merge');
  });
});
