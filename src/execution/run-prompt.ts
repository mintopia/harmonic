/**
 * The text a run sends to the harness. For a re-attempt (a task carrying
 * reviewer `feedback`), the feedback is appended as a labelled section so
 * the agent sees it while the stored `prompt` stays pristine — the
 * original and its feedback are kept structurally separate (see
 * domain/tasks.ts `reattempt`).
 */
export function promptForTask(task: { prompt: string; feedback?: string | null }): string {
  const feedback = task.feedback?.trim();
  if (!feedback) return task.prompt;
  return `${task.prompt}\n\n## Feedback from the previous attempt\n\n${feedback}`;
}
