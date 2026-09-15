// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TableView } from '../web/src/components/TableView.js';
import type { TableFilters } from '../web/src/router-model.js';
import { cleanup, makeTask, makeWorkspace, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

const filters: TableFilters = {
  state: [],
  harness: [],
  priority: [],
  search: '',
  sortBy: 'createdAt',
  order: 'desc',
};

describe('global task table (issue #597)', () => {
  it('loads global tasks and labels every row with its Workspace badge', async () => {
    const alpha = makeWorkspace({ id: 1, name: 'Alpha', color: '#ff0000' });
    const beta = makeWorkspace({ id: 2, name: 'Beta', color: '#00ff00' });
    const tasks = [
      makeTask({ id: 1, summary: 'Alpha task', workspaceId: alpha.id }),
      makeTask({ id: 2, summary: 'Beta task', workspaceId: beta.id }),
    ];
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ tasks, total: tasks.length })));
    vi.stubGlobal('fetch', fetchMock);

    const host = await mountComponent(
      createElement(TableView, {
        workspaceId: null,
        workspaces: [alpha, beta],
        epics: [],
        onOpen: () => {},
        onOpenEpic: () => {},
        filters,
        onFiltersChange: () => {},
        onNewTask: () => {},
      }),
    );

    const request = String(fetchMock.mock.calls.at(0)?.[0] ?? '');
    expect(request).not.toContain('workspaceId=');
    const alphaBadge = host.querySelector<HTMLElement>('[aria-label="Workspace: Alpha"]');
    const betaBadge = host.querySelector<HTMLElement>('[aria-label="Workspace: Beta"]');
    expect(alphaBadge).not.toBeNull();
    expect(betaBadge).not.toBeNull();
    expect(alphaBadge?.style.backgroundColor).toBe('rgb(255, 0, 0)');
    expect(betaBadge?.style.backgroundColor).toBe('rgb(0, 255, 0)');
  });
});
