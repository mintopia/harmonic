import { adapterFor } from './harness/registry.js';
import { collectUsage } from './usage.js';
import type { AppConfig } from '../config.js';
import { pricesForHarness } from '../domain/pricing.js';
import type { SessionStore } from '../domain/sessions.js';
import type { VerificationAttemptStore } from '../domain/verification-attempts.js';
import { logger } from '../logger.js';

/**
 * Resolves and persists the harnesses' native transcript (`${sessionId}.jsonl`)
 * paths for Sessions and critic verification attempts. A harness may not have
 * flushed the file by the time a dispatch or a critic turn ends, so every capture
 * here retries a few times off the hot path (or resolves lazily on read) and is
 * strictly best-effort: a missing transcript never fails an Attempt.
 */
export class TranscriptCapture {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly verificationAttempts: VerificationAttemptStore,
    private readonly getConfig: () => AppConfig,
  ) {}

  /** Claude can create its JSONL just after `session/new`; retry a few times
   * without holding up the Attempt, then leave the Session transcript-less. */
  async captureSessionTranscript(input: {
    sessionId: string;
    sessionRowId: number;
    sessionLogDir: string | undefined;
    transcriptResolver: (input: { sessionLogDir?: string | undefined; sessionId: string }) => Promise<string | null>;
  }): Promise<void> {
    for (const delayMs of [100, 500, 2_000]) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      const transcriptPath = await input.transcriptResolver({ sessionLogDir: input.sessionLogDir, sessionId: input.sessionId }).catch(
        () => null,
      );
      if (!transcriptPath) continue;
      await this.sessionStore.setTranscriptPath(input.sessionRowId, transcriptPath, Date.now()).catch(() => {});
      return;
    }
  }

  /**
   * Resolve a Session's native transcript path on demand and persist it —
   * self-heals a Session the eager {@link captureSessionTranscript} missed.
   * Returns the stored or freshly-resolved path, or null when it still cannot
   * be resolved.
   */
  async ensureSessionTranscript(sessionRowId: number): Promise<string | null> {
    const session = await this.sessionStore.get(sessionRowId).catch(() => null);
    if (!session) return null;
    if (session.transcriptPath) return session.transcriptPath;
    const resolver = adapterFor(session.harness).usage?.resolveTranscriptPath;
    if (!resolver) return null;
    const harnesses = this.getConfig().harnesses;
    const sessionLogDir = harnesses[session.harness as keyof typeof harnesses]?.sessionLogDir;
    const transcriptPath = await resolver({ sessionLogDir, sessionId: session.harnessSessionId }).catch(() => null);
    if (!transcriptPath) return null;
    await this.sessionStore.setTranscriptPath(sessionRowId, transcriptPath, Date.now()).catch(() => {});
    return transcriptPath;
  }

  /** The critic equivalent of {@link captureSessionTranscript}. */
  async captureCriticTranscript(input: {
    attemptId: number;
    sessionId: string;
    harnessId: string;
    sessionLogDir: string | undefined;
  }): Promise<void> {
    const resolver = adapterFor(input.harnessId).usage?.resolveTranscriptPath;
    if (!resolver) return;
    for (const delayMs of [100, 500, 2_000]) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      const transcriptPath = await resolver({ sessionLogDir: input.sessionLogDir, sessionId: input.sessionId }).catch(() => null);
      if (!transcriptPath) continue;
      await this.verificationAttempts.setTranscriptPath(input.attemptId, transcriptPath).catch(() => {});
      return;
    }
  }

  /**
   * Resolve the critic turn's per-model usage from its settled session log and
   * persist it, so Task Stats can bill the critic its own slice. Like the
   * transcript, the tokens rarely exist at the session-end boundary, so this
   * retries off the hot path and is strictly best-effort: a missing reading
   * only costs the critic its Stats line, never the Attempt.
   */
  async captureCriticUsage(input: {
    attemptId: number;
    sessionId: string;
    harnessId: string;
    cwd: string;
  }): Promise<void> {
    const harness = this.getConfig().harnesses[input.harnessId as keyof AppConfig['harnesses']];
    if (!harness) return;
    for (const delayMs of [100, 500, 2_000]) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      const usage = collectUsage({
        harnessId: input.harnessId,
        harness,
        cwd: input.cwd,
        sessionId: input.sessionId,
        prices: pricesForHarness(harness),
      });
      if (usage && Object.keys(usage.models).length > 0) {
        await this.verificationAttempts.setUsage(input.attemptId, JSON.stringify(usage)).catch(() => {});
        logger.info('captured critic usage', {
          attemptId: input.attemptId,
          harness: input.harnessId,
          models: Object.keys(usage.models).join(','),
        });
        return;
      }
    }
    logger.warn('critic usage unresolved after retries; Task Stats will omit this critic run', {
      attemptId: input.attemptId,
      harness: input.harnessId,
      sessionId: input.sessionId,
    });
  }
}
