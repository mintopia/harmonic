import { usd } from './cost.js';
import type { GuardrailEvent, GuardrailDimension } from './types.js';

const DIMENSION_LABELS: Record<GuardrailDimension, string> = {
  'wall-clock': 'Wall clock',
  tokens: 'Tokens',
  cost: 'Cost',
  progress: 'Progress',
  'tool-timeout': 'Tool timeout',
};

/** The dimension label alone: EventStream's `guardrail-tripped`
 * lifecycle line reuses this so the raw wire token ("wall-clock") reads as
 * the same human word the header banner already uses, instead of forking its
 * own vocabulary. Same fallback as `describeGuardrailTrip` — an unrecognised
 * dimension passes through as-is. */
export function guardrailDimensionLabel(dimension: string): string {
  return DIMENSION_LABELS[dimension as GuardrailDimension] ?? dimension;
}

const msToMinutes = (ms: number): number => Math.round(ms / 60_000);

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
  cost: (e) => `${usd(e.limitValue)} limit, spent ${usd(e.observedValue)}`,
  progress: (e) => {
    const payload = e.payload as { pattern?: string } | null | undefined;
    return payload?.pattern ? `no progress — ${payload.pattern}` : 'no progress detected';
  },
};

/**
 * A Guardrail-trip event as operator-facing prose: a short
 * dimension label plus an evidence string comparing the configured limit to
 * what was observed, in the dimension's own unit. Pure and total — an
 * unrecognised `dimension` (a future addition the client hasn't shipped a
 * formatter for yet) degrades to the raw dimension string and a generic
 * limit/observed comparison instead of throwing.
 */
export function describeGuardrailTrip(e: GuardrailEvent): { dimensionLabel: string; evidence: string } {
  const dimensionLabel = guardrailDimensionLabel(e.dimension);
  const format = EVIDENCE_FORMATTERS[e.dimension];
  const evidence = format ? format(e) : `limit ${e.limitValue}, observed ${e.observedValue}`;
  return { dimensionLabel, evidence };
}
