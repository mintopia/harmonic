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

function isFinished(event: BoundaryEvent): boolean {
  return event.type === 'lifecycle' && event.payload.event === 'finished';
}

/** One entry per turn, in send order. The text is split on the exact separator only, never trimmed or annotated. */
export function splitTurnPrompts(text: string): string[] {
  return text.split(PROMPT_SEPARATOR).filter((prompt) => prompt.trim() !== '');
}

/** How many turns have ended — a change means a new prompt may have been archived. */
export function finishedTurnCount(events: readonly BoundaryEvent[]): number {
  return events.filter(isFinished).length;
}

/** The id of the first event after each `finished`: the anchor for the next turn's prompt, in turn order. */
export function turnBoundaryAnchors(events: readonly BoundaryEvent[]): number[] {
  const anchors: number[] = [];
  let afterFinish = false;
  for (const event of events) {
    if (afterFinish) {
      anchors.push(event.id);
      afterFinish = false;
    }
    if (isFinished(event)) afterFinish = true;
  }
  return anchors;
}

// Prompts with no boundary to align to go in `trailing`; ones whose boundary is in the hidden tail are dropped.
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
