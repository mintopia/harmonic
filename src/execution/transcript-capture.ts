import { adapterFor } from './harness/registry.js';
import type { AppConfig } from '../config.js';
import type { SessionStore } from '../domain/sessions.js';
import { bestEffort, orFallback } from '../error-handling.js';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Resolves and persists the harnesses' native transcript (`${sessionId}.jsonl`)
 * paths for Sessions. A harness may not have
 * flushed the file by the time a dispatch ends, so every capture
 * here retries a few times off the hot path (or resolves lazily on read) and is
 * strictly best-effort: a missing transcript never fails an Attempt.
 */
export class TranscriptCapture {
  private readonly closing = new AbortController();

  constructor(
    private readonly sessionStore: SessionStore,
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
      if (!(await this.pause(delayMs))) return;
      const transcriptPath = await orFallback(
        () => input.transcriptResolver({ sessionLogDir: input.sessionLogDir, sessionId: input.sessionId }),
        { op: 'transcriptCapture.captureSessionTranscript.resolve', level: 'debug', context: { sessionRowId: input.sessionRowId } },
        null,
      );
      if (!transcriptPath) continue;
      await bestEffort(() => this.sessionStore.setTranscriptPath(input.sessionRowId, transcriptPath, Date.now()), {
        op: 'transcriptCapture.captureSessionTranscript.persist',
        level: 'warn',
        context: { sessionRowId: input.sessionRowId },
      });
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
    const session = await orFallback(() => this.sessionStore.get(sessionRowId), {
      op: 'transcriptCapture.ensureSessionTranscript.get',
      level: 'warn',
      context: { sessionRowId },
    }, null);
    if (!session) return null;
    if (session.transcriptPath) return session.transcriptPath;
    const resolver = adapterFor(session.harness).usage?.resolveTranscriptPath;
    if (!resolver) return null;
    const harnesses = this.getConfig().harnesses;
    const sessionLogDir = harnesses[session.harness as keyof typeof harnesses]?.sessionLogDir;
    const transcriptPath = await orFallback(() => resolver({ sessionLogDir, sessionId: session.harnessSessionId }), {
      op: 'transcriptCapture.ensureSessionTranscript.resolve',
      level: 'debug',
      context: { sessionRowId },
    }, null);
    if (!transcriptPath) return null;
    await bestEffort(() => this.sessionStore.setTranscriptPath(sessionRowId, transcriptPath, Date.now()), {
      op: 'transcriptCapture.ensureSessionTranscript.persist',
      level: 'warn',
      context: { sessionRowId },
    });
    return transcriptPath;
  }

  /** Shutdown: abandon pending retries (a later read re-resolves lazily) so nothing writes after the DB closes. */
  close(): void {
    this.closing.abort();
  }

  private async pause(ms: number): Promise<boolean> {
    try {
      await sleep(ms, undefined, { signal: this.closing.signal });
      return true;
    } catch {
      return false;
    }
  }
}
