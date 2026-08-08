/**
 * The text a native (non-mirrored) run sends to the harness. The operator's
 * Task Prompt template (global config, default bare `{prompt}`) wraps the
 * Task's own prompt; its `{prompt}/{id}/{workingDir}/{harness}/{model}`
 * placeholders are filled from the Task. For a re-attempt (a task carrying
 * reviewer `feedback`), the feedback is appended as a labelled section after
 * the filled template so the agent sees it while the stored `prompt` stays
 * pristine — the original and its feedback are kept structurally separate (see
 * domain/tasks.ts `reattempt`). The mirrored path uses the Drive Prompt
 * instead (auto-drive.ts).
 */
export interface TaskPromptFields {
  prompt: string;
  id: number;
  workingDir: string;
  harness: string;
  model: string;
}

/** Fill a Task Prompt template's `{prompt}/{id}/{workingDir}/{harness}/{model}` placeholders. */
export function buildTaskPrompt(template: string, fields: TaskPromptFields): string {
  return template.replace(
    /\{(prompt|id|workingDir|harness|model)\}/g,
    (_, key: keyof TaskPromptFields) => String(fields[key]),
  );
}

export function promptForTask(
  task: { id: number; prompt: string; workingDir: string; harness: string; model: string; feedback?: string | null },
  template: string,
): string {
  const base = buildTaskPrompt(template, {
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
