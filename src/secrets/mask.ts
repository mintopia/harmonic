import { BASELINE_REDACT_PATTERNS, Redactor } from '../archive/redact.js';

const MASK = '***';

/** Replaces every occurrence of each secret value with `***`, longest first, then applies the baseline redaction patterns. */
export function maskSecrets(text: string, values: readonly string[]): string {
  let masked = text;
  for (const value of [...values].filter((v) => v.length > 0).sort((a, b) => b.length - a.length)) {
    masked = masked.split(value).join(MASK);
  }
  return new Redactor(BASELINE_REDACT_PATTERNS).redactText(masked);
}
