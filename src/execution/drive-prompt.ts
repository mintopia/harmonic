import type { TaskRow } from '../db/schema.js';
import { buildDrivePrompt, type DriveFields } from './prompt-template.js';

/**
 * Task-aware Drive-Prompt helpers (issue #33), extracted from `auto-drive.ts` so
 * the server (`AutoDrive`, the critic verifier) can source the interpolation
 * fields from a Task without pulling in `Git`/tracker machinery. The pure
 * string primitives live in `prompt-template.ts` (also imported by the web
 * preview); re-exported here for existing importers.
 */
export { buildDrivePrompt, type DriveFields };

/**
 * research→`research`, everything else→`implement` (issue #33). Codex invokes
 * skills with a `$` prefix; every other harness uses `/`.
 */
export function skillFor(task: Pick<TaskRow, 'wayfinderType' | 'harness'>): string {
  const prefix = task.harness === 'codex' ? '$' : '/';
  return `${prefix}${task.wayfinderType === 'research' ? 'research' : 'implement'}`;
}

/** A mirrored Task's prompt is `title\n\nbody`; recover the two for the Drive Prompt. */
export function splitTitleBody(prompt: string): { title: string; body: string } {
  const i = prompt.indexOf('\n\n');
  return i === -1 ? { title: prompt, body: '' } : { title: prompt.slice(0, i), body: prompt.slice(i + 2) };
}

/**
 * Derive the {@link DriveFields} for a Task — the shared source of the five
 * tokens used by both the afk Drive Prompt (`AutoDrive.prompt`) and the agent
 * critic's review prompt (`buildCriticPrompt`). `urlFor` resolves the ticket URL
 * (null → empty string), so a native Run with no tracker URL still interpolates.
 */
export function driveFields(task: TaskRow, urlFor: (task: TaskRow) => string | null): DriveFields {
  const { title, body } = splitTitleBody(task.prompt);
  return {
    skill: skillFor(task),
    ref: String(task.trackerRef ?? ''),
    url: urlFor(task) ?? '',
    title,
    body,
  };
}
