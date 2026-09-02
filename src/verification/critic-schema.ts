import { z } from 'zod';

/** Structurally identical to `web/src/verification-model.ts`'s `Verdict`; `src` cannot import `web/src` (`rootDir`). */
export type Verdict = 'pass' | 'fail' | 'inconclusive';

/** The output contract demanded of the critic: one JSON object with `verdict` and a non-empty `summary`. */
export const criticVerdictSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'inconclusive']),
  summary: z.string().min(1),
});
export type ParsedCriticVerdict = z.infer<typeof criticVerdictSchema>;

export type ParseCriticOutputResult =
  | { ok: true; value: ParsedCriticVerdict }
  | { ok: false; verdict: 'inconclusive'; reason: string };

/** The last top-level `{...}` in `text` (string contents skipped); last wins so an injected verdict quoted earlier can't be mistaken for the agent's final answer. */
function lastBalancedObject(text: string): string | null {
  let depth = 0;
  let start = -1;
  let last: string | null = null;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          last = text.slice(start, i + 1);
          start = -1;
        }
      }
    }
  }
  return last;
}

/** The last fenced ` ```json ... ``` ` block in `text`, trimmed; `null` if none. */
function lastFencedJsonBlock(text: string): string | null {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const tail = matches.at(-1);
  return tail ? tail[1]!.trim() : null;
}

/** Extract and validate the critic's verdict: a fenced ```json block, else the last balanced `{...}`. Every failure resolves to `inconclusive`; never throws. */
export function parseCriticOutput(raw: string): ParseCriticOutputResult {
  const candidate = lastFencedJsonBlock(raw) ?? lastBalancedObject(raw);
  if (!candidate) {
    return { ok: false, verdict: 'inconclusive', reason: 'no JSON object found in critic output' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return {
      ok: false,
      verdict: 'inconclusive',
      reason: `critic output was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const result = criticVerdictSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      verdict: 'inconclusive',
      reason: `critic output failed schema validation: ${result.error.message}`,
    };
  }

  return { ok: true, value: result.data };
}
