import type { ZodType } from 'zod';
import { logger } from '../logger.js';

/** Parses a JSON column at the read boundary; a missing, corrupt or non-conforming value is `null` with a warning, never a throw. */
export function parseStoredJson<T>(schema: ZodType<T>, text: string | null | undefined, what: string): T | null {
  if (!text) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    logger.warn(`Ignoring unreadable stored ${what}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    logger.warn(`Ignoring invalid stored ${what}: ${parsed.error.issues[0]?.message ?? 'does not match its schema'}`);
    return null;
  }
  return parsed.data;
}
