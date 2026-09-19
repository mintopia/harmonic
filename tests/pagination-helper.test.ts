import { describe, expect, it, vi } from 'vitest';
import { fetchAllPages } from '../web/src/pagination.js';

describe('fetchAllPages', () => {
  it('fetches pages until exhausted and concatenates results in order', async () => {
    const fetchPage = vi.fn(async (limit: number, offset: number) => {
      const all = [0, 1, 2, 3, 4];
      return { items: all.slice(offset, offset + limit), total: all.length };
    });

    const result = await fetchAllPages(fetchPage, 2);

    expect(result).toEqual([0, 1, 2, 3, 4]);
  });

  it('stops on an empty page even if total implies more', async () => {
    const fetchPage = vi.fn(async (_limit: number, offset: number) => {
      if (offset === 0) return { items: [0, 1], total: 10 };
      return { items: [], total: 10 };
    });

    const result = await fetchAllPages(fetchPage, 2);

    expect(result).toEqual([0, 1]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('passes the correct offset/limit sequence to fetchPage', async () => {
    const fetchPage = vi.fn(async (limit: number, offset: number) => {
      const all = Array.from({ length: 7 }, (_, i) => i);
      return { items: all.slice(offset, offset + limit), total: all.length };
    });

    await fetchAllPages(fetchPage, 3);

    expect(fetchPage.mock.calls).toEqual([
      [3, 0],
      [3, 3],
      [3, 6],
    ]);
  });

  it('defaults the page size to 100 when omitted', async () => {
    const fetchPage = vi.fn(async (_limit: number, _offset: number) => ({ items: [1], total: 1 }));

    await fetchAllPages(fetchPage);

    expect(fetchPage).toHaveBeenCalledWith(100, 0);
  });
});
