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

/**
 * Guidance appended to an agent turn whose worktree Harmonic has indexed as its
 * own jCodeMunch repo (`code-index.ts`). Without it the harness's code-index MCP
 * resolves `.` to the canonical checkout on another branch and reads stale code;
 * with the explicit repo id it queries THIS worktree. Pure and dependency-free so
 * the web settings preview compiles the same text. Empty id ⇒ nothing rendered
 * (CLI absent or indexing failed — the agent falls back to reading files).
 */
export function codeIndexRepoGuidance(repoId: string): string {
  if (!repoId) return '';
  return `\n\nCODE INDEX: this worktree is indexed as jCodeMunch repo \`${repoId}\`. If you use a code-index / jCodeMunch tool, pass \`${repoId}\` as the repo for every query. Do NOT resolve the repo by \`.\` or index path — that points at a different checkout of this repository, on another branch, WITHOUT the changes in this worktree, so it would show you stale code.`;
}

/**
 * Guidance for the critic, handed the change as its two revisions — the base
 * (fork point, before the change) and the candidate (the change under review) —
 * each indexed by Harmonic as its own jCodeMunch repo (`code-index.ts`). The
 * critic never receives a git diff; it derives what changed by comparing the two
 * indexed revisions itself. Pure and dependency-free so the web settings preview
 * compiles the same text. Either id empty ⇒ nothing rendered (the caller then
 * falls back to single-repo guidance or none).
 */
export function codeIndexComparisonGuidance(baseRepoId: string, candidateRepoId: string): string {
  if (!baseRepoId || !candidateRepoId) return '';
  return `\n\nCODE INDEX: the change under review is available as its two revisions, each indexed as its own jCodeMunch repo:\n- BASE (before the change): \`${baseRepoId}\`\n- CANDIDATE (the change under review): \`${candidateRepoId}\`\nTo see exactly what this change did, compare the two via the code index — e.g. \`get_parity_map\` with source_repo \`${baseRepoId}\` and target_repo \`${candidateRepoId}\`, then read the changed symbols in \`${candidateRepoId}\`. Query \`${candidateRepoId}\` for the candidate's current code and \`${baseRepoId}\` for the prior state. Do NOT resolve either repo by \`.\` or index path — that points at a different checkout on another branch and would show you stale code.`;
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
