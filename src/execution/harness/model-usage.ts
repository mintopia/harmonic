import type { ModelUsage } from '../../domain/usage.js';

/** Coerce a JSON numeric field; anything non-numeric counts as zero. */
export const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** `models[model]`, created zeroed on first touch. */
export function usageBucket(models: Record<string, ModelUsage>, model: string): ModelUsage {
  return (models[model] ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
}

/** Add `delta`'s four token counts into `models[model]`. Does NOT touch `aiUnits`. */
export function addModelUsage(models: Record<string, ModelUsage>, model: string, delta: ModelUsage): void {
  const bucket = usageBucket(models, model);
  bucket.inputTokens += num(delta.inputTokens);
  bucket.outputTokens += num(delta.outputTokens);
  bucket.cacheReadTokens += num(delta.cacheReadTokens);
  bucket.cacheWriteTokens += num(delta.cacheWriteTokens);
}

/** Sum several per-model records into one fresh record, without mutating any input. */
export function mergeModelUsage(sources: Iterable<Record<string, ModelUsage>>): Record<string, ModelUsage> {
  const merged: Record<string, ModelUsage> = {};
  for (const source of sources) {
    for (const [model, usage] of Object.entries(source)) addModelUsage(merged, model, usage);
  }
  return merged;
}
