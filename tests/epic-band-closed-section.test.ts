// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { ClosedRail, EpicBand } from '../web/src/components/Board.js';
import type { Epic, EpicMember } from '../web/src/epic-model.js';

function member(overrides: Partial<EpicMember> = {}): EpicMember {
  return {
    ref: 1,
    title: 'Fix flaky test',
    taskId: 501,
    state: 'done',
    escalated: false,
    mergeStatus: 'completed',
    ready: false,
    ...overrides,
  };
}

const closed: EpicMember[] = [
  member({ ref: 1, title: 'Fix flaky test', taskId: 501, state: 'done', mergeStatus: 'completed' }),
  member({ ref: 2, title: 'Drop dead code path', taskId: null, state: 'cancelled', mergeStatus: 'pending' }),
];

function epic(overrides: Partial<Epic> = {}): Epic {
  return {
    ref: 423,
    title: 'Collapsible closed section',
    kind: 'spec',
    state: 'open',
    description: '',
    createdAt: 0,
    updatedAt: 0,
    baseBranch: 'develop',
    dependsOn: [],
    members: closed,
    ready: [],
    integration: { branch: 'epic/423', exists: false, tip: null },
    verification: { status: null, configured: true },
    integrate: { inFlight: false, held: null },
    foldedCount: 1,
    memberCount: 2,
    ...overrides,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('EpicBand collapsible closed-tasks section (issue #423)', () => {
  it('renders the closed members via a collapsible ClosedRail, only when there are any', () => {
    const withClosed = renderToStaticMarkup(
      createElement(EpicBand, { epic: epic(), columns: [], onOpenTask: () => {} }),
    );
    expect(withClosed).toContain('Closed · 2');

    const withoutClosed = renderToStaticMarkup(
      createElement(EpicBand, { epic: epic({ members: [] }), columns: [], onOpenTask: () => {} }),
    );
    expect(withoutClosed).not.toContain('Closed ·');
  });

  it('makes ClosedRail collapsible, collapsed by default, with a chevron disclosure', async () => {
    host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(ClosedRail, { members: closed, onOpenTask: () => {}, collapsible: true }));
    });

    const toggle = host.querySelector('button[aria-expanded]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).not.toContain('Fix flaky test');

    await act(async () => {
      (toggle as HTMLButtonElement).click();
    });

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('Fix flaky test');
  });

  it('renders each closed member as a full multi-row card, not a short row (issue #430)', async () => {
    host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(ClosedRail, { members: closed, onOpenTask: () => {}, collapsible: true }));
    });
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click();
    });

    const cards = [...host.querySelectorAll('.w-\\[300px\\]')];
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.className).not.toContain('w-[240px]');
      expect(card.querySelector('.mt-1.truncate')).not.toBeNull();
    }
    expect(host.textContent).toContain('Fix flaky test');
    expect(host.textContent).toContain('Drop dead code path');
  });
});
