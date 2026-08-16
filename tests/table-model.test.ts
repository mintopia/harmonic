import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTasks, filterBySearch, paginate, tasksQuery } from '../web/src/table-model.js';
import type { Task } from '../web/src/types.js';

/**
 * The table's fetch used to have no error handling and no `res.ok` check
 * (issue #91): a failed/non-OK response was parsed as `{ tasks }` data,
 * silently bricking the view instead of surfacing on the error toast.
 * `fetchTasks` now routes through the shared `api.ts` transport, so it stubs
 * the global `fetch` like `api-request.test.ts` does.
 */
const fakeFetch = (body: string, init: ResponseInit) => vi.fn().mockResolvedValue(new Response(body, init));

const baseQuery = { workspaceId: 1, state: '', harness: '', priority: '', sortBy: 'createdAt', order: 'desc' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tasksQuery', () => {
  it('always sets workspaceId, sortBy, and order', () => {
    const params = new URLSearchParams(tasksQuery(baseQuery));
    expect(params.get('workspaceId')).toBe('1');
    expect(params.get('sortBy')).toBe('createdAt');
    expect(params.get('order')).toBe('desc');
  });

  it('omits state, harness, and priority when empty', () => {
    const params = new URLSearchParams(tasksQuery(baseQuery));
    expect(params.has('state')).toBe(false);
    expect(params.has('harness')).toBe(false);
    expect(params.has('priority')).toBe(false);
  });

  it('includes state, harness, and priority when set', () => {
    const params = new URLSearchParams(
      tasksQuery({ ...baseQuery, state: 'running', harness: 'claude', priority: 'high' }),
    );
    expect(params.get('state')).toBe('running');
    expect(params.get('harness')).toBe('claude');
    expect(params.get('priority')).toBe('high');
  });
});

describe('fetchTasks', () => {
  it('returns the task list on a 200', async () => {
    const tasks = [{ id: 1 }, { id: 2 }] as Partial<Task>[] as Task[];
    vi.stubGlobal('fetch', fakeFetch(JSON.stringify({ tasks }), { status: 200 }));
    await expect(fetchTasks(baseQuery)).resolves.toEqual(tasks);
  });

  it('throws the server error message on a non-OK response instead of parsing it as tasks', async () => {
    vi.stubGlobal('fetch', fakeFetch(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }));
    await expect(fetchTasks(baseQuery)).rejects.toThrow('boom');
  });
});

describe('filterBySearch', () => {
  const tasks = [{ prompt: 'Add rate limiting' }, { prompt: 'Fix login' }] as Partial<Task>[] as Task[];

  it('matches a substring, case-insensitively', () => {
    expect(filterBySearch(tasks, 'rate')).toEqual([tasks[0]]);
    expect(filterBySearch(tasks, 'LOGIN')).toEqual([tasks[1]]);
  });

  it('treats a blank or whitespace-only query as "no search"', () => {
    expect(filterBySearch(tasks, '')).toEqual(tasks);
    expect(filterBySearch(tasks, '   ')).toEqual(tasks);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterBySearch(tasks, 'zzz')).toEqual([]);
  });
});

describe('paginate', () => {
  const items = Array.from({ length: 120 }, (_, i) => i);

  it('splits into pages of the default size', () => {
    const p = paginate(items, 1);
    expect(p.items).toHaveLength(50);
    expect(p.pageCount).toBe(3);
    expect(p.total).toBe(120);
  });

  it('clamps an out-of-range page to the last page', () => {
    const p = paginate(items, 99);
    expect(p.page).toBe(3);
  });

  it('clamps page 0 or negative to page 1', () => {
    expect(paginate(items, 0).page).toBe(1);
    expect(paginate(items, -5).page).toBe(1);
  });

  it('gives an empty list a single, empty page', () => {
    const p = paginate([], 1);
    expect(p.pageCount).toBe(1);
    expect(p.page).toBe(1);
    expect(p.items).toEqual([]);
  });
});
