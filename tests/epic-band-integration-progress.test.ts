import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EpicBand } from '../web/src/components/Board.js';
import { EpicIntegrationBar } from '../web/src/components/EpicIntegrationBar.js';
import type { Epic, EpicMember } from '../web/src/epic-model.js';

function epic(overrides: Partial<Epic> = {}): Epic {
  return {
    ref: 424,
    title: 'Whole-Epic integration progress',
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
    integrate: { inFlight: false, held: null },
    foldedCount: 2,
    memberCount: 2,
    ...overrides,
  };
}

describe('EpicBand whole-Epic integration progress (issue #424)', () => {
  it("makes the main-board band's content the shared integration bar while the Epic is integrating", () => {
    const html = renderToStaticMarkup(
      createElement(EpicBand, {
        epic: epic(),
        columns: [],
        onOpenTask: () => {},
        onChanged: () => {},
      }),
    );

    expect(html).toContain('Verify');
    expect(html).toContain('Merge');
    expect(html).toContain('Post-merge check');
    expect(html).toContain('Retire');
  });

  it('does not render the integration bar while the Epic is not yet integrating', () => {
    const html = renderToStaticMarkup(
      createElement(EpicBand, {
        epic: epic({ foldedCount: 1, memberCount: 2 }),
        columns: [],
        onOpenTask: () => {},
        onChanged: () => {},
      }),
    );

    expect(html).not.toContain('Post-merge check');
  });

  it('drives the bar off the server-authoritative read model, never re-derived from child states', () => {
    const html = renderToStaticMarkup(createElement(EpicIntegrationBar, { epic: epic() }));

    expect(html).toContain('Verify');
    expect(html).toContain('Merge');
    expect(html).toContain('Post-merge check');
    expect(html).toContain('Retire');
  });
});
