import { z } from 'zod';

/**
 * Shared response schemas for zod-declared routes (ADR-0005). Every route's
 * `schema.response` should reuse these instead of redefining the error
 * envelope shape, so the generated spec documents one consistent contract.
 *
 * Fields carry `.meta({ example })` wherever a plausible value helps more than
 * a type name does: the API page renders the spec's examples verbatim and only
 * synthesizes placeholders where none is declared, so an example here is the
 * difference between a reader seeing `"claude"` and seeing `"string"`.
 * Examples are illustrative, not captured traffic.
 */

/** The `{ error: { code, message } }` envelope every error response uses — see app.ts's error handler. */
export const errorResponseSchema = z
  .object({
    error: z.object({
      code: z.string().meta({ example: 'not_found' }),
      message: z.string().meta({ example: 'no task with id 4821' }),
    }),
  })
  .meta({ id: 'ErrorResponse' });

/**
 * The error envelope with a description for one specific failure.
 *
 * `.describe()` on a registered schema keeps the `$ref` and adds the
 * description beside it, so each status documents what *it* means without
 * inlining a copy of the envelope or renaming the shared definition. Fastify's
 * swagger integration reads that description as the response's own — this is
 * what replaces "Default Response".
 */
export const errorResponse = (description: string) => errorResponseSchema.describe(description);

/** The trivial `{ ok: true }` body returned by actions with nothing else to report. */
export const okResponseSchema = z
  .object({ ok: z.literal(true) })
  .meta({ id: 'OkResponse', example: { ok: true } });

/** A numeric `:id` path param, coerced from the route string — shared by tasks/runs/channels. */
export const idParamsSchema = z.object({ id: z.coerce.number().int().meta({ example: 4821 }) });

/** Per-model token counters (execution/usage.ts `ModelUsage`) — the four counters Cost prices. */
export const modelUsageSchema = z
  .object({
    inputTokens: z.number().meta({ example: 18240 }),
    outputTokens: z.number().meta({ example: 3610 }),
    cacheReadTokens: z.number().meta({ example: 26400 }),
    cacheWriteTokens: z.number().meta({ example: 1200 }),
    /** Harness-native spend units (e.g. Copilot AI Units); absent when the harness has none. */
    aiUnits: z.number().optional().meta({ example: 12 }),
  })
  .meta({ id: 'ModelUsage' });

/** Usage aggregate for a run or a rolled-up set of runs (execution/usage.ts `RunUsage`). */
export const runUsageSchema = z
  .object({
    /** Per-model breakdown (session-log fallback; ACP only reports aggregates). */
    models: z.record(z.string(), modelUsageSchema).meta({
      example: {
        'sonnet-5': { inputTokens: 18240, outputTokens: 3610, cacheReadTokens: 26400, cacheWriteTokens: 1200 },
      },
    }),
    /** Aggregate token counts; null when no source reported tokens. */
    totals: modelUsageSchema.extend({ totalTokens: z.number().meta({ example: 49450 }).nullable() }).nullable(),
    /** Tool-call tallies from the run's events. */
    toolCalls: z.record(z.string(), z.number()).meta({ example: { read: 14, edit: 6, bash: 3 } }),
    source: z.enum(['acp', 'session-log', 'combined']).nullable().meta({ example: 'acp' }),
  })
  .meta({ id: 'RunUsage' });

/** The dollar value of Usage, derived on read from the live price table (execution/pricing.ts `Cost`). */
export const costSchema = z
  .object({
    /** Sum over priced models; null when nothing could be priced. */
    totalUsd: z.number().nullable().meta({ example: 0.52 }),
    /** $ per model; null for models without a price entry. */
    byModel: z.record(z.string(), z.number().nullable()).meta({ example: { 'sonnet-5': 0.52 } }),
    /** True when any tokens in the aggregate could not be priced. */
    incomplete: z.boolean().meta({ example: false }),
  })
  .meta({ id: 'Cost' });
