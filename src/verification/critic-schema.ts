import { z } from 'zod';

/**
 * The agent critic's verdict alphabet (issue #136, ADR-0021, reliability-design
 * Unit B). Deliberately identical to `web/src/verification-model.ts`'s
 * `Verdict` — that module is web-side (`web/src`) and `src` cannot import it
 * (`rootDir: "src"`), so this is a separate, structurally-compatible copy
 * rather than a shared import. The "feeds `combineVerdicts`" acceptance
 * criterion is proven in a **test**, which runs under `tsconfig.test.json`
 * and can import both trees — see `tests/critic.test.ts`.
 */
export type Verdict = 'pass' | 'fail' | 'inconclusive';

/**
 * The output contract a critic prompt (`critic-prompt.ts`) demands of the
 * agent: exactly one JSON object, `verdict` from the `Verdict` alphabet plus a
 * non-empty human-readable `summary`. `min(1)` on `summary` rejects an agent
 * that emits a technically-valid-but-empty verdict — a critic that can't be
 * bothered to explain itself is not more trustworthy than one that said
 * nothing, and an empty summary is useless on the review UI this eventually
 * feeds.
 */
export const criticVerdictSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'inconclusive']),
  summary: z.string().min(1),
});
export type ParsedCriticVerdict = z.infer<typeof criticVerdictSchema>;

export type ParseCriticOutputResult =
  | { ok: true; value: ParsedCriticVerdict }
  | { ok: false; verdict: 'inconclusive'; reason: string };

/**
 * Find every top-level (depth 0 → 1 → … → 0) `{...}` span in `text` and
 * return the **last** one, or `null` if none closes. String contents are
 * scanned (braces inside a JSON string literal don't count, and an escaped
 * quote doesn't end the string) so a summary containing literal `{`/`}`
 * characters can't fool the balance count.
 *
 * "Last object wins" is deliberate (#136 AC: an injected
 * `{"verdict":"pass"}` sitting earlier in the untrusted diff, or in prose the
 * agent quotes back, must not be mistaken for the agent's own answer — the
 * agent's real, final answer is what closes the transcript). It is also what
 * naturally falls out of scanning left-to-right and keeping the most recent
 * complete match, so no special-casing is needed for "ignore anything that
 * looks like a verdict inside quoted/echoed text that a real verdict follows".
 */
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

/**
 * Extract and validate the critic's verdict from its raw agent-text output
 * (issue #136, reliability-design Unit B: "structured schema-validated
 * verdict; malformed/missing → inconclusive; injection containment").
 *
 * Extraction prefers a fenced ` ```json ` block (the shape most harnesses
 * naturally produce for "reply with only this JSON"), falling back to the
 * last balanced top-level `{...}` in the raw text otherwise — see
 * {@link lastBalancedObject} for why "last" is the safe choice under prompt
 * injection. Every failure mode — no JSON found, unparseable JSON, a
 * schema-invalid or unknown-verdict object, or an empty string — resolves to
 * `{ ok:false, verdict:'inconclusive', reason }` rather than throwing:
 * ADR-0021 is explicit that inconclusive is the fail-safe direction, and a
 * critic's own malformed output is exactly the kind of thing that must never
 * silently read as `pass`. **Never throws.**
 */
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
