import { z } from 'zod';

/**
 * Shared response schemas for zod-declared routes (ADR-0005). Every route's
 * `schema.response` should reuse these instead of redefining the error
 * envelope shape, so the generated spec documents one consistent contract.
 */

/** The `{ error: { code, message } }` envelope every error response uses — see app.ts's error handler. */
export const errorResponseSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
    }),
  })
  .meta({ id: 'ErrorResponse' });

/** The trivial `{ ok: true }` body returned by actions with nothing else to report. */
export const okResponseSchema = z.object({ ok: z.literal(true) }).meta({ id: 'OkResponse' });

/** A numeric `:id` path param, coerced from the route string — shared by tasks/runs/channels. */
export const idParamsSchema = z.object({ id: z.coerce.number().int() });

/** Per-model token counters (execution/usage.ts `ModelUsage`) — the four counters Cost prices. */
export const modelUsageSchema = z
  .object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheWriteTokens: z.number(),
    /** Harness-native spend units (e.g. Copilot AI Units); absent when the harness has none. */
    aiUnits: z.number().optional(),
  })
  .meta({ id: 'ModelUsage' });

/** Usage aggregate for a run or a rolled-up set of runs (execution/usage.ts `RunUsage`). */
export const runUsageSchema = z
  .object({
    /** Per-model breakdown (session-log fallback; ACP only reports aggregates). */
    models: z.record(z.string(), modelUsageSchema),
    /** Aggregate token counts; null when no source reported tokens. */
    totals: modelUsageSchema.extend({ totalTokens: z.number().nullable() }).nullable(),
    /** Tool-call tallies from the run's events. */
    toolCalls: z.record(z.string(), z.number()),
    source: z.enum(['acp', 'session-log', 'combined']).nullable(),
  })
  .meta({ id: 'RunUsage' });

/** The dollar value of Usage, derived on read from the live price table (execution/pricing.ts `Cost`). */
export const costSchema = z
  .object({
    /** Sum over priced models; null when nothing could be priced. */
    totalUsd: z.number().nullable(),
    /** $ per model; null for models without a price entry. */
    byModel: z.record(z.string(), z.number().nullable()),
    /** True when any tokens in the aggregate could not be priced. */
    incomplete: z.boolean(),
  })
  .meta({ id: 'Cost' });
