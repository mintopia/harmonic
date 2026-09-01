import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTasks, tasksQuery, type TableQuery } from '../web/src/table-model.js';
import type { Task } from '../web/src/types.js';

const fakeFetch = (body: string, init: ResponseInit) => vi.fn().mockResolvedValue(new Response(body, init));

const baseQuery: TableQuery = {
  workspaceId: 1,
  state: [],
  harness: [],
  priority: [],
  q: '',
  sortBy: 'createdAt',
  order: 'desc',
  limit: 50,
  offset: 0,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tasksQuery', () => {
  it('always sets workspaceId, sortBy, order, limit, and offset', () => {
    const params = new URLSearchParams(tasksQuery({ ...baseQuery, limit: 50, offset: 100 }));
    expect(params.get('workspaceId')).toBe('1');
    expect(params.get('sortBy')).toBe('createdAt');
    expect(params.get('order')).toBe('desc');
    expect(params.get('limit')).toBe('50');
    expect(params.get('offset')).toBe('100');
  });

  it('opts into derived-epic rows (ADR-0016) so the list can merge them server-side', () => {
    expect(new URLSearchParams(tasksQuery(baseQuery)).get('epics')).toBe('true');
  });

  it('omits state, harness, priority, and a blank search', () => {
    const params = new URLSearchParams(tasksQuery({ ...baseQuery, q: '   ' }));
    expect(params.has('state')).toBe(false);
    expect(params.has('harness')).toBe(false);
    expect(params.has('priority')).toBe(false);
    expect(params.has('q')).toBe(false);
  });

  it('includes state, harness, priority, and a trimmed search when set', () => {
    const params = new URLSearchParams(
      tasksQuery({ ...baseQuery, state: ['running'], harness: ['claude'], priority: ['high'], q: '  rate limiting  ' }),
    );
    expect(params.get('state')).toBe('running');
    expect(params.get('harness')).toBe('claude');
    expect(params.get('priority')).toBe('high');
    expect(params.get('q')).toBe('rate limiting');
  });

  it('sends a multi-select filter as one comma-separated param', () => {
    const params = new URLSearchParams(
      tasksQuery({ ...baseQuery, state: ['ready', 'working'], priority: ['high', 'low'] }),
    );
    expect(params.get('state')).toBe('ready,working');
    expect(params.get('priority')).toBe('high,low');
  });
});

describe('fetchTasks', () => {
  it('returns the page and its total on a 200', async () => {
    const tasks = [{ id: 1 }, { id: 2 }] as Partial<Task>[] as Task[];
    vi.stubGlobal('fetch', fakeFetch(JSON.stringify({ tasks, total: 42 }), { status: 200 }));
    await expect(fetchTasks(baseQuery)).resolves.toEqual({ tasks, total: 42 });
  });

  it('throws the server error message on a non-OK response instead of parsing it as tasks', async () => {
    vi.stubGlobal('fetch', fakeFetch(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }));
    await expect(fetchTasks(baseQuery)).rejects.toThrow('boom');
  });
});
