/**
 * Pure prompt-template primitives (issue #33) with **zero** server/browser
 * dependencies, so both the server (the critic) and the web
 * settings preview can import them without dragging in `TaskRow`/drizzle or any
 * node built-in. Keep this module dependency-free.
 */

/** The five interpolation tokens a Drive-style prompt fills. */
export type DriveFields = {
  skill: string;
  ref: string;
  url: string;
  title: string;
  body: string;
};

type DriveTask = {
  harness: string;
  wayfinderType: string | null;
  prompt: string;
  trackerRef: number | null;
};

/** Fill supplied `{key}` placeholders without interpreting values as templates. */
export function fillTemplate(template: string, fields: Record<string, string | number>): string {
  return template.replace(/\{([^{}]+)\}/g, (match, key: string) => (key in fields ? String(fields[key]) : match));
}

/** research→`research`, everything else→`implement` (issue #33). */
export function skillFor(task: Pick<DriveTask, 'wayfinderType' | 'harness'>): string {
  const prefix = task.harness === 'codex' ? '$' : '/';
  return `${prefix}${task.wayfinderType === 'research' ? 'research' : 'implement'}`;
}

/** A mirrored Task's prompt is `title\n\nbody`; recover the two for the Drive Prompt. */
export function splitTitleBody(prompt: string): { title: string; body: string } {
  const i = prompt.indexOf('\n\n');
  return i === -1 ? { title: prompt, body: '' } : { title: prompt.slice(0, i), body: prompt.slice(i + 2) };
}

/** Derive the fields used by the Drive and critic prompt templates. */
export function driveFields<T extends DriveTask>(task: T, urlFor: (task: T) => string | null): DriveFields {
  const { title, body } = splitTitleBody(task.prompt);
  return {
    skill: skillFor(task),
    ref: String(task.trackerRef ?? ''),
    url: urlFor(task) ?? '',
    title,
    body,
  };
}

/** The text a native (non-mirrored) run sends to the harness. */
export function promptForTask(
  task: { id: number; prompt: string; workingDir: string; harness: string; model: string; feedback?: string | null },
  template: string,
): string {
  const base = fillTemplate(template, {
    prompt: task.prompt,
    id: task.id,
    workingDir: task.workingDir,
    harness: task.harness,
    model: task.model,
  });
  const feedback = task.feedback?.trim();
  if (!feedback) return base;
  return `${base}\n\n## Feedback from the previous attempt\n\n${feedback}`;
}
