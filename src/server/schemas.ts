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
