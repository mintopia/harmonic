export const PROMPT_SEPARATOR = '\n\n---\n\n';
export const PROMPT_INDEX_FILE = 'prompt.index.jsonl';

/** Where the `index`-th Resolved Prompt sits in `prompt.md`, in bytes. */
export interface PromptSpan {
  readonly index: number;
  readonly start: number;
  readonly length: number;
}

export function promptSpanLine(span: PromptSpan): string {
  return `${JSON.stringify(span)}\n`;
}

/** The sidecar's spans, or null when it is absent, corrupt, overlapping, out of order, or reaches past the prompt file. Lines written before spans carried their own index take their position as index. */
export function parsePromptSpans(text: string, bodyBytes: number): PromptSpan[] | null {
  const spans: PromptSpan[] = [];
  let previousEnd = 0;
  let previousIndex = -1;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let parsed: { index?: unknown; start?: unknown; length?: unknown };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      return null;
    }
    const index = parsed.index === undefined ? previousIndex + 1 : parsed.index;
    const { start, length } = parsed;
    if (!Number.isInteger(index) || !Number.isInteger(start) || !Number.isInteger(length)) return null;
    const span = { index: index as number, start: start as number, length: length as number };
    if (span.index <= previousIndex || span.start < previousEnd || span.length < 0 || span.start + span.length > bodyBytes) return null;
    spans.push(span);
    previousIndex = span.index;
    previousEnd = span.start + span.length;
  }
  return spans.length > 0 ? spans : null;
}

function splitRegion(region: string): string[] {
  const trimmed = region.startsWith(PROMPT_SEPARATOR) ? region.slice(PROMPT_SEPARATOR.length) : region;
  return trimmed.split(PROMPT_SEPARATOR).filter((piece) => piece.trim() !== '');
}

/** Every prompt of `prompt.md`, position = prompt index; gaps the sidecar misses are recovered between spans. */
export function readPromptSegments(body: Buffer, spans: readonly PromptSpan[] | null): string[] {
  const out: string[] = [];
  let cursor = 0;
  for (const span of spans ?? []) {
    const gap = span.index - out.length;
    if (gap > 0) {
      const region = body.subarray(cursor, span.start).toString('utf8');
      const trimmed = region.endsWith(PROMPT_SEPARATOR) ? region.slice(0, -PROMPT_SEPARATOR.length) : region;
      const pieces = gap === 1 ? [trimmed.startsWith(PROMPT_SEPARATOR) ? trimmed.slice(PROMPT_SEPARATOR.length) : trimmed] : splitRegion(trimmed);
      for (let i = 0; i < gap; i++) out.push(pieces[i] ?? '');
    }
    out.push(body.subarray(span.start, span.start + span.length).toString('utf8'));
    cursor = span.start + span.length;
  }
  out.push(...splitRegion(body.subarray(cursor).toString('utf8')));
  return out;
}
