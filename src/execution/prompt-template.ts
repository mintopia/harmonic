import type { PromptFragmentName, PromptFragments } from '../domain/prompt-fragments.js';
import type { TrackerRef } from '../tracker/adapter.js';
/** The interpolation tokens a Drive-style prompt fills. `taskId`/`title`/
 * `description` are always populated — a native (non-mirrored) Task has no
 * ticket, so only `ref`/`url` go empty. */
export type DriveFields = {
  taskId: string;
  skill: string;
  ref: string;
  url: string;
  title: string;
  description: string;
};

type DriveTask = {
  id: number;
  harness: string;
  wayfinderType: string | null;
  prompt: string;
  trackerRef: TrackerRef | null;
  mapRef: TrackerRef | null;
  epicKind?: string | null;
};

/** Fill supplied `{key}` placeholders without interpreting values as templates. */
export function fillTemplate(template: string, fields: Record<string, string | number>): string {
  return template.replace(/\{([^{}]+)\}/g, (match, key: string) => (key in fields ? String(fields[key]) : match));
}

/** Expand `{fragment.<name>}` references in a template from the shared Prompt Fragments, leaving unknown names intact. */
export function expandFragments(template: string, fragments: Record<string, string>): string {
  return fillTemplate(
    template,
    Object.fromEntries(Object.entries(fragments).map(([name, text]) => [`fragment.${name}`, text])),
  );
}

/** Render one Prompt Fragment: fragment references expand first, then the runtime fields fill in a single pass so their values are never re-expanded. */
export function renderFragment(name: PromptFragmentName, fragments: PromptFragments, fields: Record<string, string | number> = {}): string {
  return fillTemplate(expandFragments(fragments[name], fragments), fields);
}

/**
 * Guidance appended to an agent turn whose worktree Harmonic has indexed as its
 * own jCodeMunch repo. Empty id ⇒ nothing rendered.
 */
export function codeIndexRepoGuidance(repoId: string, fragments: PromptFragments): string {
  if (!repoId) return '';
  return `\n\n${renderFragment('codeIndexGuidance', fragments, { repoId })}`;
}

/** Map-Epic child→`wayfinder`; research→`research`; everything else→`implement`. */
export function skillFor(task: Pick<DriveTask, 'wayfinderType' | 'harness' | 'epicKind'>): string {
  const skill = task.epicKind === 'map' ? 'wayfinder' : task.wayfinderType === 'research' ? 'research' : 'implement';
  return `${task.harness === 'codex' ? '$' : '/'}${skill}`;
}

/** A mirrored Task's prompt is `title\n\nbody`; recover the two for the Drive Prompt. */
export function splitTitleBody(prompt: string): { title: string; body: string } {
  const i = prompt.indexOf('\n\n');
  return i === -1 ? { title: prompt, body: '' } : { title: prompt.slice(0, i), body: prompt.slice(i + 2) };
}

/** Derive the fields used by the Drive and critic prompt templates. */
export function driveFields<T extends DriveTask>(task: T, urlFor: (task: T) => string | null): DriveFields {
  const { title, body } = splitTitleBody(task.prompt);
  const isMapChild = task.epicKind === 'map';
  const ref = isMapChild ? task.mapRef : task.trackerRef;
  return {
    taskId: String(task.id),
    skill: skillFor(task),
    ref: String(ref ?? ''),
    url: urlFor(isMapChild ? { ...task, trackerRef: task.mapRef } : task) ?? '',
    title,
    description: body,
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
