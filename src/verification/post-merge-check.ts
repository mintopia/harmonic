import type { TaskArchive } from '../archive/task-archive.js';
import type { AppConfig } from '../config.js';
import type { TaskRow, AttemptRow, WorkspaceRow } from '../db/schema.js';
import type { AttemptStore } from '../domain/attempts.js';
import { DomainError } from '../domain/errors.js';
import { resolveVerifiers } from '../domain/setting-override.js';
import type { VerificationAttemptStore } from '../domain/verification-attempts.js';
import type { FireAndForget } from '../error-handling.js';
import { indexWorktree } from '../execution/code-index.js';
import { Git } from '../execution/git.js';
import { driveFields } from '../execution/prompt-template.js';
import type { TranscriptCapture } from '../execution/transcript-capture.js';
import type { PostMergeCheckResult } from '../execution/merge-policy.js';
import { commandAttemptToInput, type CommandSpawn } from './command-verifier.js';
import { runPostMergeCommands } from './post-merge-commands.js';
import { criticAttemptToInput, runCritic, type CriticHarnessDrive } from './critic.js';

type VerifierWorkspace = Pick<WorkspaceRow,
  'taskPreMergeCommands' | 'taskPreMergeCritics' | 'taskPostMergeCommands' | 'taskPostMergeCritics' | 'epicPreMergeCommands' | 'epicPreMergeCritics'>;

type PostMergeInput = {
  task: TaskRow;
  run: AttemptRow;
  mergeOid: string;
  baseDir: string;
  verificationAttempt?: AttemptRow;
  signal?: AbortSignal;
  record?: (type: 'lifecycle', payload: unknown) => void;
  onUpdate?: Parameters<typeof runCritic>[0]['onUpdate'];
  urlFor?: (task: TaskRow) => string | null;
};

export function createPostMergeCheck(deps: {
  getWorkspace: (workspaceId: number | null) => Promise<VerifierWorkspace | undefined>;
  getConfig: () => AppConfig;
  verificationAttempts: VerificationAttemptStore;
  attempts: AttemptStore;
  criticDrive: CriticHarnessDrive;
  commandSpawn: CommandSpawn;
  fireAndForget: FireAndForget;
  archive?: TaskArchive | undefined;
  transcripts: TranscriptCapture;
}): (input: PostMergeInput) => Promise<PostMergeCheckResult> {
  const { getWorkspace, getConfig, verificationAttempts, attempts, criticDrive, commandSpawn, fireAndForget, archive: taskArchive, transcripts } = deps;
  return async ({
    task,
    run,
    mergeOid,
    baseDir,
    verificationAttempt = run,
    signal,
    record,
    onUpdate,
    urlFor = () => null,
  }) => {
    const ws = await getWorkspace(task.workspaceId);
    const config = getConfig();
    const { task: resolvedTask } = resolveVerifiers(
      ws ?? { taskPreMergeCommands: null, taskPreMergeCritics: null, taskPostMergeCommands: null, taskPostMergeCritics: null, epicPreMergeCommands: null, epicPreMergeCritics: null },
      config,
    );
    const { commands, critics } = resolvedTask.postMerge;
    const commandResult = await runPostMergeCommands({
      commands,
      cwd: baseDir,
      mergeOid,
      commandSpawn,
      signal,
      attributes: { 'task.id': task.id, 'attempt.id': run.id },
      outputLog: async (command) => (await taskArchive?.verificationOutputLog(task, run.number, 'post-merge', command.id)) ?? null,
      onAttempt: async (cmdAttempt) => {
        await verificationAttempts.append(verificationAttempt.id, commandAttemptToInput(cmdAttempt));
        record?.('lifecycle', { event: 'verification', mechanism: 'command', verdict: cmdAttempt.verdict, summary: cmdAttempt.summary });
      },
    });
    if (!commandResult.pass) return commandResult;
    // A merge with no first parent (root commit, or a rewritten history) just means no base-diff context for the critic; the critic falls back to its no-baseOid prompt.
    const baseOid = await Git.revParse(baseDir, `${mergeOid}^1`).catch(() => null);
    if (critics.length > 0) await indexWorktree(baseDir);
    const criticAttempts = await Promise.all(critics.map(async (configuredCritic, index) => {
      const critic = {
        prompt: task.trackerRef == null ? configuredCritic.noIssuePrompt : configuredCritic.issuePrompt,
        model: configuredCritic.model,
        ...(configuredCritic.harness ? { harness: configuredCritic.harness } : {}),
      };
      const harnessId = critic.harness ?? task.harness;
      const harness = config.harnesses[harnessId as keyof AppConfig['harnesses']];
      if (!harness) throw new DomainError('validation', `critic harness '${harnessId}' is not configured`);
      const archive = taskArchive?.criticStep(task, verificationAttempt.number, 'post-merge', `critic-${index + 1}`);
      const attempt = await runCritic({
        cwd: baseDir,
        verifiedHeadOid: mergeOid,
        ...(baseOid ? { baseOid } : {}),
        critic,
        timeoutMs: configuredCritic.timeoutSeconds * 1000,
        fields: driveFields(task, urlFor),
        harness,
        harnessId,
        attributes: { 'task.id': task.id, 'attempt.id': run.id },
        drive: criticDrive,
        ...(archive ? { archive } : {}),
        ...(onUpdate ? { onUpdate } : {}),
        onAgentDurationMs: (ms: number) => attempts.addAgentDuration(run.id, ms),
      });
      const persisted = await verificationAttempts.append(verificationAttempt.id, criticAttemptToInput(attempt));
      const sessionId = attempt.sessionId;
      if (sessionId) {
        if (attempt.transcriptPath === null) {
          fireAndForget(() => transcripts.captureCriticTranscript({
            attemptId: persisted.id, sessionId, harnessId, sessionLogDir: harness.sessionLogDir,
          }), { op: 'postMerge.captureCriticTranscript', level: 'warn', context: { attemptId: persisted.id } });
        }
        fireAndForget(() => transcripts.captureCriticUsage({
          attemptId: persisted.id, sessionId, harnessId, cwd: baseDir,
        }), { op: 'postMerge.captureCriticUsage', level: 'warn', context: { attemptId: persisted.id } });
      }
      record?.('lifecycle', { event: 'verification', mechanism: 'critic', verdict: attempt.verdict, summary: attempt.summary });
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
