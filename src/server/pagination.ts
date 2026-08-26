import { z } from 'zod';

/** The page size a migrating client should request when it has no reason to pick
 * another (ADR-0045). Not enforced as a mandatory server default: an omitted
 * `limit` returns the whole filtered list, so un-migrated callers are unaffected
 * while endpoints move onto this contract one at a time. */
export const DEFAULT_LIMIT = 50;
/** The hard cap on an explicit `limit`, so a single page can never pull the
 * whole corpus back in and re-create the payload problem ADR-0045 solves. */
export const MAX_LIMIT = 200;

/** The shared `limit`/`offset` query fragment every list endpoint mixes in. */
export const paginationQuerySchema = z.object({
  /** Page size. Omitted ⇒ the whole filtered list (additive rollout); capped at {@link MAX_LIMIT}. */
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional().meta({ example: 50 }),
  /** Rows to skip before the page. Omitted ⇒ 0. */
  offset: z.coerce.number().int().nonnegative().optional().meta({ example: 0 }),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Slice a fully-resolved, already-filtered list into one page and report the
 * pre-slice `total`. An omitted `limit` returns every row (the additive default),
 * so an endpoint gains the envelope without changing what its current callers
 * receive. */
export function paginate<T>(items: T[], { limit, offset = 0 }: PaginationQuery = {}): { items: T[]; total: number } {
  const total = items.length;
  const page = limit === undefined ? items.slice(offset) : items.slice(offset, offset + limit);
  return { items: page, total };
}

/** The shared list envelope: the page under `key`, plus the filtered `total`.
 * Reused by every list endpoint so the paginated shape stays uniform. */
export function listResponse<K extends string, T extends z.ZodTypeAny>(key: K, item: T) {
  return z.object({
    [key]: z.array(item),
    total: z.number().int().nonnegative().meta({ example: 340 }),
  } as Record<K, z.ZodArray<T>> & { total: z.ZodNumber });
}
