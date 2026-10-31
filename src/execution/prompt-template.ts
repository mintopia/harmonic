import type { BundledPromptCode, EnginePrompts } from '../domain/bundled-prompts.js';
import { INCLUDE } from '../domain/prompt-library.js';
import { translateRetiredText } from '../domain/retired-settings.js';
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

/** Expand `${{ prompts.<code> }}` includes from the engine prompts, leaving unknown codes intact; retired fragment references are read as includes. */
export function expandIncludes(template: string, prompts: EnginePrompts): string {
  return translateRetiredText(template).replace(INCLUDE, (whole, code: string) => (Object.hasOwn(prompts, code) ? prompts[code as BundledPromptCode] : whole));
}

/** Render one engine prompt: includes expand first, then the runtime fields fill in a single pass so their values are never re-expanded. */
export function renderPrompt(code: BundledPromptCode, prompts: EnginePrompts, fields: Record<string, string | number> = {}): string {
  return fillTemplate(expandIncludes(prompts[code], prompts), fields);
}

/**
 * Guidance appended to an agent turn whose worktree Harmonic has indexed as its
 * own jCodeMunch repo. Empty id ⇒ nothing rendered.
 */
export function codeIndexRepoGuidance(repoId: string, prompts: EnginePrompts): string {
  if (!repoId) return '';
  return `\n\n${renderPrompt('codeIndexGuidance', prompts, { repoId })}`;
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

export function appendFeedback(text: string, feedback: string | null | undefined): string {
  const trimmed = feedback?.trim();
  return trimmed ? `${text}\n\n## Feedback from the previous attempt\n\n${trimmed}` : text;
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
  return appendFeedback(base, task.feedback);
}
