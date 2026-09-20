import type { AppConfig } from '../config.js';
import type { TaskRow, AttemptRow } from '../db/schema.js';
import { DomainError } from '../domain/errors.js';
import { resolveVerifiers } from '../domain/setting-override.js';
import type { VerificationAttemptStore } from '../domain/verification-attempts.js';
import type { WorkspaceService } from '../domain/workspaces.js';
import { attempted } from '../error-handling.js';
import { indexWorktree } from '../execution/code-index.js';
import { Git } from '../execution/git.js';
import { driveFields } from '../execution/prompt-template.js';
import type { SettingsStore } from '../server/settings-store.js';
import { commandAttemptToInput, runCommandVerifier } from './command-verifier.js';
import { criticAttemptToInput, runCritic, type CriticHarnessDrive } from './critic.js';

export function createPostMergeCheck(deps: {
  workspaces: WorkspaceService;
  settingsStore: SettingsStore;
  verificationAttempts: VerificationAttemptStore;
  criticDrive?: CriticHarnessDrive | undefined;
}): (input: { task: TaskRow; run: AttemptRow; mergeOid: string; baseDir: string }) => Promise<{ pass: boolean; output: string }> {
  const { workspaces, settingsStore, verificationAttempts, criticDrive } = deps;
  return async ({
    task,
    run,
    mergeOid,
    baseDir,
  }: {
    task: TaskRow;
    run: AttemptRow;
    mergeOid: string;
    baseDir: string;
  }) => {
    const workspaceId = task.workspaceId;
    const resolvedWs =
      workspaceId == null
        ? null
        : await attempted(() => workspaces.get(workspaceId), {
            op: 'postMerge.resolveWorkspace',
            level: 'error',
            context: { taskId: task.id, attemptId: run.id, workspaceId },
          });
    const ws = resolvedWs?.ok === true ? resolvedWs.value : undefined;
    const { task: resolvedTask } = resolveVerifiers(
      ws ?? { taskPreMergeCommands: null, taskPreMergeCritics: null, taskPostMergeCommands: null, taskPostMergeCritics: null, epicPreMergeCommands: null, epicPreMergeCritics: null },
      settingsStore.getGlobal(),
    );
    const { commands, critics } = resolvedTask.postMerge;
    for (const command of commands) {
      const cmdAttempt = await runCommandVerifier({
        cwd: baseDir,
        verifiedHeadOid: mergeOid,
        command,
        attributes: { 'task.id': task.id, 'attempt.id': run.id },
      });
      await verificationAttempts.append(run.id, commandAttemptToInput(cmdAttempt));
      if (cmdAttempt.verdict !== 'pass') return { pass: false, output: cmdAttempt.output };
    }
    // A merge with no first parent (root commit, or a rewritten history) just means no base-diff context for the critic; the critic falls back to its no-baseOid prompt.
    const baseOid = await Git.revParse(baseDir, `${mergeOid}^1`).catch(() => null);
    if (critics.length > 0) await indexWorktree(baseDir);
    const criticAttempts = await Promise.all(critics.map(async (configuredCritic) => {
      const critic = {
        prompt: task.trackerRef == null ? configuredCritic.noIssuePrompt : configuredCritic.issuePrompt,
        model: configuredCritic.model,
        ...(configuredCritic.harness ? { harness: configuredCritic.harness } : {}),
      };
      const harnessId = critic.harness ?? task.harness;
      const harness = settingsStore.getGlobal().harnesses[harnessId as keyof AppConfig['harnesses']];
      if (!harness) throw new DomainError('validation', `critic harness '${harnessId}' is not configured`);
      const attempt = await runCritic({
        cwd: baseDir,
        verifiedHeadOid: mergeOid,
        ...(baseOid ? { baseOid } : {}),
        critic,
        fields: driveFields(task, () => null),
        harness,
        harnessId,
        attributes: { 'task.id': task.id, 'attempt.id': run.id },
        ...(criticDrive ? { drive: criticDrive } : {}),
      });
      await verificationAttempts.append(run.id, criticAttemptToInput(attempt));
      return attempt;
    }));
    const output = criticAttempts
      .map((attempt, index) => [attempt, index] as const)
      .filter(([attempt]) => attempt.verdict !== 'pass')
      .map(([attempt, index]) => [
        `Task critic ${index + 1} (${attempt.verdict}): ${attempt.summary}`,
        attempt.output,
      ].filter(Boolean).join('\n'))
      .join('\n\n');
    return { pass: output.length === 0, output };
  };
}
