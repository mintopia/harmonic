import { describe, it, expect } from 'vitest';
import { paginate, MAX_LIMIT, paginationQuerySchema } from '../src/server/pagination.js';

describe('paginate', () => {
  const items = Array.from({ length: 10 }, (_, i) => i);

  it('returns the whole list and its total when no limit is given (additive default)', () => {
    expect(paginate(items)).toEqual({ items, total: 10 });
    expect(paginate(items, {})).toEqual({ items, total: 10 });
  });

  it('slices to a page while reporting the full pre-slice total', () => {
    expect(paginate(items, { limit: 3 })).toEqual({ items: [0, 1, 2], total: 10 });
    expect(paginate(items, { limit: 3, offset: 3 })).toEqual({ items: [3, 4, 5], total: 10 });
  });

  it('offset without limit skips into the tail', () => {
    expect(paginate(items, { offset: 8 })).toEqual({ items: [8, 9], total: 10 });
  });

  it('an offset past the end yields an empty page, total unchanged', () => {
    expect(paginate(items, { limit: 5, offset: 50 })).toEqual({ items: [], total: 10 });
  });
});

describe('paginationQuerySchema', () => {
  it('coerces string query params to numbers', () => {
    expect(paginationQuerySchema.parse({ limit: '25', offset: '5' })).toEqual({ limit: 25, offset: 5 });
  });

  it('rejects a limit over the max', () => {
    expect(paginationQuerySchema.safeParse({ limit: String(MAX_LIMIT + 1) }).success).toBe(false);
  });

  it('rejects a negative offset and a non-positive limit', () => {
    expect(paginationQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });
});
