import type { AcpInitializeResult } from '../acp/driver.js';
import type { AppConfig, HarnessConfig } from '../config.js';
import type { AttemptRow, SessionRow, TaskRow } from '../db/schema.js';
import type { AttemptStore } from '../domain/attempts.js';
import { resolveScoped } from '../domain/setting-override.js';
import {
  decideAttemptContinuation,
  planSessionContinuation,
  sessionWarmthFacts,
  type ContinuationTrigger,
  type DeterministicContinuation,
} from '../domain/session-continuation.js';
import { assessResumeEligibility, sessionFacts, type ResumeEnvironment } from '../domain/session-resume.js';
import type { SessionStore } from '../domain/sessions.js';
import { bestEffort, fireAndForget, reportFailure } from '../error-handling.js';
import { adapterFor, adapterVersion } from './harness/registry.js';
import { repoKey } from './repo-lock.js';
import type { TranscriptCapture } from './transcript-capture.js';
import type { RunnerOptions, Workspace } from './runner.js';
import type { AttemptUsage, AttemptUsageSnapshot } from './usage.js';

function configuredCacheWarmSeconds(config: AppConfig, harness: string): number | undefined {
  return Object.entries(config.harnesses).find(([id]) => id === harness)?.[1].cacheWarmSeconds;
}

export interface PersistSessionContext {
  task: TaskRow;
  run: AttemptRow;
  harness: HarnessConfig;
  workspace: Workspace;
  mcpServers: unknown[];
  attemptAtStart: AttemptRow;
  getSessionInit: () => AcpInitializeResult | undefined;
  setSessionRowId: (id: number) => void;
}

/**
 * Owns Runner's session-persistence and continuation-decision behaviour:
 * resolving and binding a prior Session to continue, resume eligibility, the
 * deterministic continue-vs-condense decision, condensed-context generation,
 * and persisting a freshly dispatched Session.
 */
export class SessionContinuation {
  constructor(
    private readonly attempts: AttemptStore,
    private readonly sessionStore: SessionStore,
    private readonly transcripts: TranscriptCapture,
    private readonly getConfig: () => AppConfig,
    private readonly usage: { latestSnapshot: (attemptId: number) => Promise<AttemptUsageSnapshot | null> },
    private readonly getLastTurnContextTokens: (attemptId: number) => number | undefined,
    private readonly dispatchCwd: (task: TaskRow) => string,
  ) {}

  async resolveContinuationSource(
    task: TaskRow,
  ): Promise<{ prior: AttemptRow; session: SessionRow; trigger: ContinuationTrigger } | null> {
    const priors = await this.attempts.listForTask(task.id);
    for (let i = priors.length - 1; i >= 0; i--) {
      const prior = priors[i]!;
      if (prior.sessionRowId === null) continue;
      try {
        const session = await this.sessionStore.get(prior.sessionRowId);
        return { prior, session, trigger: 'manual-resume' };
      } catch {
        continue;
      }
    }
    return null;
  }

  async bindContinuationIfEligible(task: TaskRow, run: AttemptRow): Promise<AttemptRow> {
    try {
      const src = await this.resolveContinuationSource(task);
      if (!src) return run;
      if (!this.resumeEligibilityFor(task, src.session).eligible) return run;

      const cacheWarmSeconds = configuredCacheWarmSeconds(this.getConfig(), task.harness);
      if (cacheWarmSeconds === undefined) return run;
      const plan = planSessionContinuation(src.trigger, sessionWarmthFacts(src.session, cacheWarmSeconds), Date.now());

      if (plan.mode === 'offer-choice' && task.continuationChoice === 'condensed') {
        return run;
      }

      const bound = await this.attempts.update(run.id, {
        sessionRowId: src.session.id,
        sessionId: src.session.harnessSessionId,
      });
      await bestEffort(() => this.sessionStore.reactivate(src.session.id, Date.now()), {
        op: 'runner.resumeSession.reactivate',
        level: 'warn',
        context: { taskId: task.id, attemptId: run.id, sessionRowId: src.session.id },
      });
      return bound;
    } catch (err) {
      reportFailure(err, { op: 'runner.resumeSession', level: 'warn', context: { taskId: task.id, attemptId: run.id } });
      return run;
    }
  }

  resumeEligibilityFor(task: TaskRow, session: SessionRow) {
    const env: ResumeEnvironment = {
      harness: session.harness,
      adapterVersion: adapterVersion(task.harness),
      model: task.model,
      availablePermissionModes: session.permissionMode ? [session.permissionMode] : [],
      cwd: repoKey(this.dispatchCwd(task)),
    };
    const stored = { ...sessionFacts(session), cwd: repoKey(session.cwd) };
    return assessResumeEligibility(stored, env);
  }

  async decideContinuation(
    task: TaskRow,
    run: AttemptRow,
    workspace: Awaited<ReturnType<NonNullable<RunnerOptions['getWorkspace']>>>,
  ): Promise<DeterministicContinuation> {
    const now = Date.now();
    const session = run.sessionRowId === null ? null : await this.sessionStore.get(run.sessionRowId).catch(() => null);
    const persisted = run.usage ? (JSON.parse(run.usage) as AttemptUsage).contextTokens ?? null : null;
    const contextTokens = (await this.usage.latestSnapshot(run.id))?.contextTokens ?? this.getLastTurnContextTokens(run.id) ?? persisted;
    return decideAttemptContinuation({
      cacheWarmSeconds: configuredCacheWarmSeconds(this.getConfig(), task.harness) ?? 0,
      contextTokens,
      lastActiveAt: session?.lastActiveAt ?? now,
      contextReuseTokenLimit: resolveScoped('contextReuseTokenLimit', workspace?.contextReuseTokenLimit, this.getConfig().contextReuseTokenLimit),
      now,
    });
  }

  async condensedContext(run: AttemptRow): Promise<string | null> {
    if (run.sessionRowId === null) return null;
    const session = await this.sessionStore.get(run.sessionRowId).catch(() => null);
    if (!session) return null;
    const current = await this.attempts.get(run.id);
    const events = await this.attempts.listEvents(run.id);
    return [
      '## Prior session (condensed)',
      'This attempt starts a fresh Session under the deterministic continuation rule.',
      `Prior Session: ${session.harness} / ${session.model} / ${session.harnessSessionId}`,
      `Verified head: ${current.verifiedHeadOid ?? '(none produced)'}`,
      `Attempt events: ${events.length}.`,
    ].join('\n');
  }

  async persistSession(harnessSessionId: string, ctx: PersistSessionContext): Promise<void> {
    const { task, run, harness, workspace, mcpServers, attemptAtStart } = ctx;
    fireAndForget(() => this.attempts.update(run.id, { sessionId: harnessSessionId }), {
      op: 'runner.persistSession.bindSessionId',
      level: 'warn',
      context: { attemptId: run.id, harnessSessionId },
    });
    try {
      const transcriptResolver = adapterFor(task.harness).usage?.resolveTranscriptPath;
      const transcriptPath = await transcriptResolver?.({
        sessionLogDir: harness.sessionLogDir,
        sessionId: harnessSessionId,
      });
      const session = await this.sessionStore.recordDispatch({
        harness: task.harness,
        harnessSessionId,
        model: task.model,
        cwd: workspace.cwd,
        workspaceId: task.workspaceId,
        ...(transcriptPath !== undefined ? { transcriptPath } : {}),
        mcpTemplates: mcpServers,
        capabilities: ctx.getSessionInit(),
        adapterVersion: adapterVersion(task.harness),
        now: Date.now(),
      });
      ctx.setSessionRowId(session.id);
      fireAndForget(() => this.attempts.update(run.id, { sessionRowId: session.id }), {
        op: 'runner.persistSession.bindSessionRow',
        level: 'error',
        context: { attemptId: run.id, sessionRowId: session.id },
      });
      fireAndForget(
        async () => {
          const steps = await this.attempts.listSteps(attemptAtStart.id);
          const implementation = steps.find((row) => row.type === 'implementation' && row.state === 'running');
          if (implementation) await this.attempts.updateStep(implementation.id, { logLocator: `session:${session.id}` });
        },
        {
          op: 'runner.persistSession.linkStepLog',
          level: 'warn',
          context: { attemptId: attemptAtStart.id, sessionRowId: session.id },
        },
      );
      if (transcriptPath === null && transcriptResolver) {
        void this.transcripts.captureSessionTranscript({ sessionId: harnessSessionId, sessionRowId: session.id, sessionLogDir: harness.sessionLogDir, transcriptResolver });
      }
    } catch (err) {
      reportFailure(err, {
        op: 'runner.persistSession',
        level: 'error',
        context: {
          taskId: task.id,
          attemptId: run.id,
          harness: task.harness,
          harnessSessionId,
          workspaceId: task.workspaceId ?? undefined,
          cwd: workspace.cwd,
        },
      });
    }
  }

  /** Resolve a Session's native transcript path on demand and persist it. */
  async ensureSessionTranscript(sessionRowId: number): Promise<string | null> {
    return this.transcripts.ensureSessionTranscript(sessionRowId);
  }
}
