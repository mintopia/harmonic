const DERIVED_TITLE_MAX = 80;

export function firstLineTitle(text: string | null): string | null {
  if (!text) return null;
  const line = text.split('\n').find((l) => l.trim().length > 0)?.trim();
  if (!line) return null;
  return line.length > DERIVED_TITLE_MAX ? `${line.slice(0, DERIVED_TITLE_MAX - 1).trimEnd()}…` : line;
}

export function taskDisplayTitle(task: { trackerTitle: string | null; prompt: string }): string | null {
  return task.trackerTitle?.trim() || firstLineTitle(task.prompt);
}
