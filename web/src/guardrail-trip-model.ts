import { usd } from './cost.js';
import type { GuardrailEvent, GuardrailDimension } from './types.js';

/** Human-readable label per dimension (issue #171); an unrecognised
 * dimension falls back to the raw string rather than throwing. */
const DIMENSION_LABELS: Record<GuardrailDimension, string> = {
  'wall-clock': 'Wall clock',
  tokens: 'Tokens',
  cost: 'Cost',
  progress: 'Progress',
  'tool-timeout': 'Tool timeout',
};

const msToMinutes = (ms: number): number => Math.round(ms / 60_000);

/** wall-clock and tool-timeout share the same ms-limit shape and read the
 * same way: "N min limit, ran N min". */
const minutesEvidence = (e: GuardrailEvent): string =>
  `${msToMinutes(e.limitValue)} min limit, ran ${msToMinutes(e.observedValue)} min`;

const EVIDENCE_FORMATTERS: Record<GuardrailDimension, (e: GuardrailEvent) => string> = {
  'wall-clock': minutesEvidence,
  'tool-timeout': (e) => {
    const payload = e.payload as { title?: string } | null | undefined;
    const target = payload?.title ? ` (${payload.title})` : '';
    return `${minutesEvidence(e)}${target}`;
  },
  tokens: (e) => `${e.limitValue.toLocaleString()} token limit, used ${e.observedValue.toLocaleString()}`,
  // limitValue/observedValue are dollars already (not cents) — the same USD
  // convention as Cost elsewhere, so this reuses cost.ts's `usd` formatter.
  cost: (e) => `${usd(e.limitValue)} limit, spent ${usd(e.observedValue)}`,
  // Progress has no scalar bound — its limitValue is a "no limit" sentinel
  // (0) and the real evidence rides in payload.pattern (issue #171 spec).
  progress: (e) => {
    const payload = e.payload as { pattern?: string } | null | undefined;
    return payload?.pattern ? `no progress — ${payload.pattern}` : 'no progress detected';
  },
};

/**
 * A Guardrail-trip event (issue #171) as operator-facing prose: a short
 * dimension label plus an evidence string comparing the configured limit to
 * what was observed, in the dimension's own unit. Pure and total — an
 * unrecognised `dimension` (a future addition the client hasn't shipped a
 * formatter for yet) degrades to the raw dimension string and a generic
 * limit/observed comparison instead of throwing.
 */
export function describeGuardrailTrip(e: GuardrailEvent): { dimensionLabel: string; evidence: string } {
  const dimensionLabel = DIMENSION_LABELS[e.dimension] ?? e.dimension;
  const format = EVIDENCE_FORMATTERS[e.dimension];
  const evidence = format ? format(e) : `limit ${e.limitValue}, observed ${e.observedValue}`;
  return { dimensionLabel, evidence };
}
