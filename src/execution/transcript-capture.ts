import { adapterFor } from './harness/adapter.js';
import type { AppConfig } from '../config.js';
import type { SessionStore } from '../domain/sessions.js';
import type { VerificationAttemptStore } from '../domain/verification-attempts.js';

/**
 * Resolves and persists the harnesses' native transcript (`${sessionId}.jsonl`)
 * paths for Sessions and critic verification attempts. A harness may not have
 * flushed the file by the time a dispatch or a critic turn ends, so every capture
 * here retries a few times off the hot path (or resolves lazily on read) and is
 * strictly best-effort: a missing transcript never fails a Run.
 */
export class TranscriptCapture {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly verificationAttempts: VerificationAttemptStore,
    private readonly getConfig: () => AppConfig,
  ) {}

  /** Claude can create its JSONL just after `session/new`; retry a few times
   * without holding up the Run, then leave the Session transcript-less. */
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
   * Resolve a Session's native transcript path on demand and persist it — the
   * read-path counterpart to {@link captureSessionTranscript}. The eager capture at
   * dispatch races the harness writing its `${sessionId}.jsonl` and gives up after
   * a few hundred ms; anything that delays the first turn (e.g. pre-turn work) can
   * push the file past that window and leave `transcriptPath` null forever. By the
   * time a reader asks for the transcript the file exists, so resolving here
   * removes the dependence on that startup race entirely and self-heals a Session
   * the eager pass missed. Returns the stored or freshly-resolved path, or null
   * when it still cannot be resolved (unknown harness, no resolver, file absent).
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

  /** The critic equivalent of {@link captureSessionTranscript}: the harness may
   * not have flushed its `${sessionId}.jsonl` by the time the critic turn ends
   * and the attempt is appended (root cause of a persistently null critic
   * transcript). Retry a few times off the hot path, then fill the attempt's
   * transcript locator so the operator's on-demand critic-session log resolves. */
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
}
