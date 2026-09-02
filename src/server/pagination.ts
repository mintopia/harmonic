import { z } from 'zod';

/** The hard cap on an explicit `limit`. */
export const MAX_LIMIT = 200;

/** The shared `limit`/`offset` query fragment every list endpoint mixes in. */
export const paginationQuerySchema = z.object({
  /** Page size. Omitted ⇒ the whole filtered list; capped at {@link MAX_LIMIT}. */
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional().meta({ example: 50 }),
  /** Rows to skip before the page. Omitted ⇒ 0. */
  offset: z.coerce.number().int().nonnegative().optional().meta({ example: 0 }),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Slice a fully-resolved, already-filtered list into one page and report the
 * pre-slice `total`. An omitted `limit` returns every row. */
export function paginate<T>(items: T[], { limit, offset = 0 }: PaginationQuery = {}): { items: T[]; total: number } {
  const total = items.length;
  const page = limit === undefined ? items.slice(offset) : items.slice(offset, offset + limit);
  return { items: page, total };
}

/** The shared list envelope: the page under `key`, plus the filtered `total`. */
export function listResponse<K extends string, T extends z.ZodTypeAny>(key: K, item: T) {
  return z.object({
    [key]: z.array(item),
    total: z.number().int().nonnegative().meta({ example: 340 }),
  } as Record<K, z.ZodArray<T>> & { total: z.ZodNumber });
}
