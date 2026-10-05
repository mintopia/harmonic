// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EpicAttemptsTimeline } from '../web/src/components/EpicPage.js';
import { EpicTimeline } from '../web/src/components/EpicTimeline.js';
import { epicTimelineRows } from '../web/src/epic-timeline-model.js';
import type { Epic } from '../web/src/epic-model.js';
import type { EpicAttempt } from '../web/src/types.js';
import { cleanup, mountComponent } from './component-smoke-harness.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => new Response(`sent via ${url}`, { status: 200, headers: { 'content-type': 'text/plain' } }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(cleanup);

const attempt: EpicAttempt = {
  id: 55,
  number: 2,
  state: 'passed',
  reason: null,
  usage: null,
  cost: null,
  toolCalls: 0,
  contextTokens: null,
  startedAt: 1_000,
  endedAt: 2_000,
  steps: [],
  verificationAttempts: [],
  resolverPrompts: [
    { kind: 'refresh', locator: 'resolution/epic-refresh-1/prompt.md', promptIndex: 0, ts: 1_100 },
    { kind: 'verification', locator: 'resolution/epic-resolve-1/prompt.md', promptIndex: 1, ts: 1_200 },
    { kind: 'merge-conflict', locator: 'resolution/epic-conflict-1/prompt.md', promptIndex: 0, ts: 1_300 },
  ],
};

const epic = (): Epic => ({
  ref: '31',
  title: 'No attempt yet',
  kind: 'spec',
  state: 'open',
  description: '',
  createdAt: 1_000,
  updatedAt: null,
  baseBranch: 'develop',
  dependsOn: [],
  members: [],
  ready: [],
  integration: { branch: 'epic/31', exists: true, tip: 'abc1234' },
  verification: { status: 'pending', configured: true },
  integrate: { inFlight: false, held: null },
  mergeSteps: [],
  timelineEvents: [{ seq: 1, at: 2_000, step: { step: 'resolver-prompt', kind: 'refresh', attempt: 1, locator: 'resolution/epic-refresh-1/prompt.md', promptIndex: 0 } }],
  foldedCount: 0,
  memberCount: 0,
  inPlace: false,
});

describe('Epic resolver prompts on the Epic page', () => {
  it('shows each resolver prompt inline under its Epic Attempt row with the resolver label', async () => {
    const host = await mountComponent(createElement(EpicAttemptsTimeline, { attempts: [attempt] }));
    const blocks = [...host.querySelectorAll('[data-testid="prompt-sent"]')];
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => b.firstElementChild?.textContent)).toEqual([
      'Prompt sent · Epic refresh resolver',
      'Prompt sent · Epic verification resolver',
      'Prompt sent · Epic merge conflict resolver',
    ]);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      '/api/attempts/55/resolved-prompt?locator=resolution%2Fepic-refresh-1%2Fprompt.md&index=0',
      '/api/attempts/55/resolved-prompt?locator=resolution%2Fepic-resolve-1%2Fprompt.md&index=1',
      '/api/attempts/55/resolved-prompt?locator=resolution%2Fepic-conflict-1%2Fprompt.md&index=0',
    ]);
    expect(blocks[0]?.querySelector('pre')?.textContent).toContain('sent via /api/attempts/55');
  });

  it('renders an Attempt-less resolver prompt as a timeline row that reads the Epic-scoped route', async () => {
    const row = epicTimelineRows(epic()).find((r) => r.prompt);
    expect(row).toMatchObject({ label: 'Epic refresh resolver prompt sent', tag: 'INTEGRATION', prompt: { attempt: 1, index: 0 } });
    const host = await mountComponent(createElement(EpicTimeline, { epic: epic(), workspaceId: 3 }));
    await act(async () => {});
    expect(host.textContent).toContain('Epic refresh resolver prompt sent');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/workspaces/3/epics/31/resolved-prompt?attempt=1&locator=resolution%2Fepic-refresh-1%2Fprompt.md&index=0');
    expect(host.querySelector('[data-testid="prompt-sent"] pre')?.textContent).toContain('sent via /api/workspaces/3/epics/31/resolved-prompt');
  });
});
