// Must match the Archive's step prompt separator (src/archive/task-archive.ts).
export const PROMPT_SEPARATOR = '\n\n---\n\n';

export const IMPLEMENTATION_PROMPT_LOCATOR = 'implementation/prompt.md';

export interface TurnPrompt {
  /** 1-based turn number within the implementation step. */
  turn: number;
  text: string;
}

interface BoundaryEvent {
  id: number;
  type: string;
  payload: { [key: string]: unknown };
}

function isPromptSent(event: BoundaryEvent): boolean {
  return event.type === 'lifecycle' && event.payload.event === 'prompt_sent';
}

/** One entry per turn, in send order. The text is split on the exact separator only, never trimmed or annotated. */
export function splitTurnPrompts(text: string): string[] {
  return text.split(PROMPT_SEPARATOR).filter((prompt) => prompt.trim() !== '');
}

/** How many prompts have been sent — a change means a new prompt was archived. */
export function promptSentCount(events: readonly BoundaryEvent[]): number {
  return events.filter(isPromptSent).length;
}

/** Event ids of the 2nd, 3rd, ... `prompt_sent` markers: the anchors for turn 2+ prompts, in send order. */
export function promptSentAnchors(events: readonly BoundaryEvent[]): number[] {
  return events.filter(isPromptSent).slice(1).map((event) => event.id);
}

// Prompts with no marker to align to go in `trailing`; ones whose marker is in the hidden tail are dropped.
export function placeTurnPrompts(
  later: readonly string[],
  anchors: readonly number[],
  rowKeys: readonly (number | string)[],
): { before: Map<number | string, TurnPrompt[]>; trailing: TurnPrompt[] } {
  const numeric = rowKeys.filter((key): key is number => typeof key === 'number');
  const visibleFrom = numeric[0] ?? Number.NEGATIVE_INFINITY;
  const before = new Map<number | string, TurnPrompt[]>();
  const trailing: TurnPrompt[] = [];
  later.forEach((text, index) => {
    const prompt = { turn: index + 2, text };
    const anchor = anchors[index];
    if (anchor === undefined) {
      trailing.push(prompt);
      return;
    }
    if (anchor < visibleFrom) return;
    const key = numeric.find((candidate) => candidate >= anchor);
    if (key === undefined) {
      trailing.push(prompt);
      return;
    }
    before.set(key, [...(before.get(key) ?? []), prompt]);
  });
  return { before, trailing };
}
