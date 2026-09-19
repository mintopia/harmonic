import type { ModelUsage } from '../../domain/usage.js';

export const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

export function usageBucket(models: Record<string, ModelUsage>, model: string): ModelUsage {
  return (models[model] ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
}

export function addTokenCounts(models: Record<string, ModelUsage>, model: string, delta: ModelUsage): void {
  const bucket = usageBucket(models, model);
  bucket.inputTokens += num(delta.inputTokens);
  bucket.outputTokens += num(delta.outputTokens);
  bucket.cacheReadTokens += num(delta.cacheReadTokens);
  bucket.cacheWriteTokens += num(delta.cacheWriteTokens);
}

export function mergeModelUsage(sources: Iterable<Record<string, ModelUsage>>): Record<string, ModelUsage> {
  const merged: Record<string, ModelUsage> = {};
  for (const source of sources) {
    for (const [model, usage] of Object.entries(source)) addTokenCounts(merged, model, usage);
  }
  return merged;
}
