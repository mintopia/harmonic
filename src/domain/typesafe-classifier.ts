import { z } from 'zod';
import type { ClassifierBackend } from './route-classifier.js';
import { resolveClassifierSettings } from './model-options.js';
import type { AttemptUsage } from './usage.js';

export const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

const responseSchema = z.object({
  answers: z.object({
    route: z.object({ choice: z.string(), confidence: z.number().optional() }),
  }),
  usage: z
    .object({ cost: z.number().optional(), input_tokens: z.number().optional(), output_tokens: z.number().optional() })
    .optional(),
});

export function createTypesafeClassifierBackend(deps: {
  reveal: (workspaceId: number, name: string) => Promise<string | null>;
  url?: string;
}): ClassifierBackend {
  return {
    async classify(input, { timeoutMs, workspace, prompt }) {
      const settings = resolveClassifierSettings(workspace);
      if (!settings.typesafeSecret) throw new Error('no Secret is configured for the TypeSafe backend');
      const key = await deps.reveal(workspace.id, settings.typesafeSecret);
      if (!key) throw new Error(`Secret '${settings.typesafeSecret}' is not set`);
      const { options, ...state } = input;
      const body = {
        model: settings.typesafeModel,
        state,
        questions: {
          route: {
            type: 'choice',
            instructions: prompt,
            criteria: Object.fromEntries(options.map((o) => [o.id, o.description])),
          },
        },
      };
      const scrub = (text: string) => text.split(key).join('[redacted]');
      let res: Response;
      try {
        res = await fetch(deps.url ?? OPENROUTER_DECISIONS_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-title': 'Harmonic Route Classifier' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        if (name === 'TimeoutError' || name === 'AbortError') throw new Error(`timed out after ${timeoutMs}ms`);
        throw new Error(scrub(`TypeSafe request failed: ${error instanceof Error ? error.message : String(error)}`));
      }
      if (!res.ok) {
        const detail = scrub((await res.text().catch(() => '')).slice(0, 200));
        throw new Error(`TypeSafe request failed with HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
      }
      const parsed = responseSchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success) throw new Error('TypeSafe response did not contain a route decision');
      const { choice, confidence } = parsed.data.answers.route;
      const u = parsed.data.usage;
      const inputTokens = u?.input_tokens ?? 0;
      const outputTokens = u?.output_tokens ?? 0;
      const usage: AttemptUsage | null = u
        ? {
            models: { [settings.typesafeModel]: { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 } },
            totals: { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: inputTokens + outputTokens },
            toolCalls: {},
            source: null,
          }
        : null;
      return {
        output: {
          optionId: choice,
          reason: `TypeSafe ${settings.typesafeModel} chose '${choice}'${confidence === undefined ? '' : ` (confidence ${confidence.toFixed(2)})`}`,
        },
        usage,
        ...(u?.cost === undefined ? {} : { costUsd: u.cost, model: settings.typesafeModel }),
      };
    },
  };
}
