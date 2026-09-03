import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptCapture } from '../src/execution/transcript-capture.js';
import type { SessionStore } from '../src/domain/sessions.js';
import type { VerificationAttemptStore } from '../src/domain/verification-attempts.js';
import type { AppConfig } from '../src/config.js';

const { resolveTranscriptPath, collectUsage } = vi.hoisted(() => ({ resolveTranscriptPath: vi.fn(), collectUsage: vi.fn() }));

vi.mock('../src/execution/harness/registry.js', () => ({
  adapterFor: (harnessId: string) => (harnessId === 'no-resolver' ? { usage: {} } : { usage: { resolveTranscriptPath } }),
}));

vi.mock('../src/execution/usage.js', () => ({ collectUsage }));

function fakeSessionStore(over: Record<string, unknown> = {}): SessionStore {
  return { get: vi.fn(), setTranscriptPath: vi.fn().mockResolvedValue(undefined), ...over } as unknown as SessionStore;
}

function fakeVerificationAttempts(over: Record<string, unknown> = {}): VerificationAttemptStore {
  return {
    setTranscriptPath: vi.fn().mockResolvedValue(undefined),
    setUsage: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as VerificationAttemptStore;
}

function fakeConfig(harnesses: Record<string, { sessionLogDir?: string }> = {}): () => AppConfig {
  return () => ({ harnesses }) as unknown as AppConfig;
}

describe('TranscriptCapture', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resolveTranscriptPath.mockReset();
    collectUsage.mockReset();
  });

  afterEach(() => vi.useRealTimers());

  describe('captureSessionTranscript', () => {
    it('persists the resolved path on the first attempt', async () => {
      const sessionStore = fakeSessionStore();
      const capture = new TranscriptCapture(sessionStore, fakeVerificationAttempts(), fakeConfig());
      const resolver = vi.fn().mockResolvedValue('/transcripts/sess-1.jsonl');

      const done = capture.captureSessionTranscript({
        sessionId: 'sess-1',
        sessionRowId: 42,
        sessionLogDir: undefined,
        transcriptResolver: resolver,
      });
      await vi.advanceTimersByTimeAsync(100);
      await done;

      expect(resolver).toHaveBeenCalledTimes(1);
      expect(resolver).toHaveBeenCalledWith({ sessionLogDir: undefined, sessionId: 'sess-1' });
      expect(sessionStore.setTranscriptPath).toHaveBeenCalledWith(42, '/transcripts/sess-1.jsonl', expect.any(Number));
    });

    it('retries across the 100/500/2000ms backoff and gives up when nothing resolves', async () => {
      const sessionStore = fakeSessionStore();
      const capture = new TranscriptCapture(sessionStore, fakeVerificationAttempts(), fakeConfig());
      const resolver = vi.fn().mockResolvedValue(null);

      const done = capture.captureSessionTranscript({
        sessionId: 'sess-2',
        sessionRowId: 7,
        sessionLogDir: '/logs',
        transcriptResolver: resolver,
      });
      await vi.advanceTimersByTimeAsync(100 + 500 + 2_000);
      await done;

      expect(resolver).toHaveBeenCalledTimes(3);
      expect(sessionStore.setTranscriptPath).not.toHaveBeenCalled();
    });

    it('treats a rejected resolver like a miss and keeps retrying until it succeeds', async () => {
      const sessionStore = fakeSessionStore();
      const capture = new TranscriptCapture(sessionStore, fakeVerificationAttempts(), fakeConfig());
      const resolver = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('/transcripts/sess-3.jsonl');

      const done = capture.captureSessionTranscript({
        sessionId: 'sess-3',
        sessionRowId: 9,
        sessionLogDir: undefined,
        transcriptResolver: resolver,
      });
      await vi.advanceTimersByTimeAsync(100 + 500);
      await done;

      expect(resolver).toHaveBeenCalledTimes(2);
      expect(sessionStore.setTranscriptPath).toHaveBeenCalledWith(9, '/transcripts/sess-3.jsonl', expect.any(Number));
    });

    it('never throws when persisting the resolved path fails', async () => {
      const sessionStore = fakeSessionStore({ setTranscriptPath: vi.fn().mockRejectedValue(new Error('db down')) });
      const capture = new TranscriptCapture(sessionStore, fakeVerificationAttempts(), fakeConfig());
      const resolver = vi.fn().mockResolvedValue('/transcripts/sess-4.jsonl');

      const done = capture.captureSessionTranscript({
        sessionId: 'sess-4',
        sessionRowId: 1,
        sessionLogDir: undefined,
        transcriptResolver: resolver,
      });
      await vi.advanceTimersByTimeAsync(100);

      await expect(done).resolves.toBeUndefined();
    });
  });

  describe('ensureSessionTranscript', () => {
    it('returns the already-stored path without resolving again', async () => {
      const sessionStore = fakeSessionStore({
        get: vi.fn().mockResolvedValue({ transcriptPath: '/already.jsonl', harness: 'claude', harnessSessionId: 'hs-1' }),
      });
      const capture = new TranscriptCapture(sessionStore, fakeVerificationAttempts(), fakeConfig());

      const result = await capture.ensureSessionTranscript(5);

      expect(result).toBe('/already.jsonl');
      expect(resolveTranscriptPath).not.toHaveBeenCalled();
      expect(sessionStore.setTranscriptPath).not.toHaveBeenCalled();
    });

    it('returns null when the Session cannot be loaded', async () => {
      const sessionStore = fakeSessionStore({ get: vi.fn().mockRejectedValue(new Error('not_found')) });
      const capture = new TranscriptCapture(sessionStore, fakeVerificationAttempts(), fakeConfig());

      const result = await capture.ensureSessionTranscript(999);

      expect(result).toBeNull();
    });

    it('returns null when the harness exposes no transcript resolver', async () => {
      const sessionStore = fakeSessionStore({
        get: vi.fn().mockResolvedValue({ transcriptPath: null, harness: 'no-resolver', harnessSessionId: 'hs-2' }),
      });
      const capture = new TranscriptCapture(sessionStore, fakeVerificationAttempts(), fakeConfig());

      const result = await capture.ensureSessionTranscript(6);

      expect(result).toBeNull();
      expect(sessionStore.setTranscriptPath).not.toHaveBeenCalled();
    });

    it('resolves on demand and persists a path the eager capture missed', async () => {
      resolveTranscriptPath.mockResolvedValueOnce('/resolved.jsonl');
      const sessionStore = fakeSessionStore({
        get: vi.fn().mockResolvedValue({ transcriptPath: null, harness: 'claude', harnessSessionId: 'hs-3' }),
      });
      const capture = new TranscriptCapture(sessionStore, fakeVerificationAttempts(), fakeConfig({ claude: { sessionLogDir: '/logs/claude' } }));

      const result = await capture.ensureSessionTranscript(3);

      expect(result).toBe('/resolved.jsonl');
      expect(resolveTranscriptPath).toHaveBeenCalledWith({ sessionLogDir: '/logs/claude', sessionId: 'hs-3' });
      expect(sessionStore.setTranscriptPath).toHaveBeenCalledWith(3, '/resolved.jsonl', expect.any(Number));
    });

    it('returns null when the on-demand resolve still misses', async () => {
      resolveTranscriptPath.mockResolvedValueOnce(null);
      const sessionStore = fakeSessionStore({
        get: vi.fn().mockResolvedValue({ transcriptPath: null, harness: 'claude', harnessSessionId: 'hs-4' }),
      });
      const capture = new TranscriptCapture(sessionStore, fakeVerificationAttempts(), fakeConfig());

      const result = await capture.ensureSessionTranscript(4);

      expect(result).toBeNull();
      expect(sessionStore.setTranscriptPath).not.toHaveBeenCalled();
    });
  });

  describe('captureCriticTranscript', () => {
    it('persists the resolved critic transcript on the Verification attempt', async () => {
      resolveTranscriptPath.mockResolvedValueOnce('/critic.jsonl');
      const verificationAttempts = fakeVerificationAttempts();
      const capture = new TranscriptCapture(fakeSessionStore(), verificationAttempts, fakeConfig());

      const done = capture.captureCriticTranscript({
        attemptId: 11,
        sessionId: 'critic-sess',
        harnessId: 'claude',
        sessionLogDir: '/logs',
      });
      await vi.advanceTimersByTimeAsync(100);
      await done;

      expect(resolveTranscriptPath).toHaveBeenCalledWith({ sessionLogDir: '/logs', sessionId: 'critic-sess' });
      expect(verificationAttempts.setTranscriptPath).toHaveBeenCalledWith(11, '/critic.jsonl');
    });

    it('retries across the full backoff and persists nothing when it never resolves', async () => {
      resolveTranscriptPath.mockResolvedValue(null);
      const verificationAttempts = fakeVerificationAttempts();
      const capture = new TranscriptCapture(fakeSessionStore(), verificationAttempts, fakeConfig());

      const done = capture.captureCriticTranscript({
        attemptId: 12,
        sessionId: 'critic-sess-2',
        harnessId: 'claude',
        sessionLogDir: undefined,
      });
      await vi.advanceTimersByTimeAsync(100 + 500 + 2_000);
      await done;

      expect(resolveTranscriptPath).toHaveBeenCalledTimes(3);
      expect(verificationAttempts.setTranscriptPath).not.toHaveBeenCalled();
    });

    it('returns immediately when the harness exposes no transcript resolver', async () => {
      const verificationAttempts = fakeVerificationAttempts();
      const capture = new TranscriptCapture(fakeSessionStore(), verificationAttempts, fakeConfig());

      await capture.captureCriticTranscript({
        attemptId: 13,
        sessionId: 'critic-sess-3',
        harnessId: 'no-resolver',
        sessionLogDir: undefined,
      });

      expect(resolveTranscriptPath).not.toHaveBeenCalled();
      expect(verificationAttempts.setTranscriptPath).not.toHaveBeenCalled();
    });
  });

  describe('captureCriticUsage', () => {
    const usage = { models: { 'opus-4.8': { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } } };

    it('persists usage resolved from the settled critic session log', async () => {
      collectUsage.mockReturnValueOnce(null).mockReturnValueOnce(usage);
      const verificationAttempts = fakeVerificationAttempts();
      const capture = new TranscriptCapture(
        fakeSessionStore(),
        verificationAttempts,
        fakeConfig({ claude: { sessionLogDir: '/logs', models: [] } }),
      );

      const done = capture.captureCriticUsage({ attemptId: 21, sessionId: 'critic-sess', harnessId: 'claude', cwd: '/wt' });
      await vi.advanceTimersByTimeAsync(100 + 500);
      await done;

      expect(collectUsage).toHaveBeenCalledTimes(2);
      expect(verificationAttempts.setUsage).toHaveBeenCalledWith(21, JSON.stringify(usage));
    });

    it('retries the full backoff and persists nothing when usage never resolves', async () => {
      collectUsage.mockReturnValue(null);
      const verificationAttempts = fakeVerificationAttempts();
      const capture = new TranscriptCapture(
        fakeSessionStore(),
        verificationAttempts,
        fakeConfig({ claude: { sessionLogDir: '/logs', models: [] } }),
      );

      const done = capture.captureCriticUsage({ attemptId: 22, sessionId: 'critic-sess-2', harnessId: 'claude', cwd: '/wt' });
      await vi.advanceTimersByTimeAsync(100 + 500 + 2_000);
      await done;

      expect(collectUsage).toHaveBeenCalledTimes(3);
      expect(verificationAttempts.setUsage).not.toHaveBeenCalled();
    });

    it('returns immediately when the critic harness is not configured', async () => {
      const verificationAttempts = fakeVerificationAttempts();
      const capture = new TranscriptCapture(fakeSessionStore(), verificationAttempts, fakeConfig({}));

      await capture.captureCriticUsage({ attemptId: 23, sessionId: 'critic-sess-3', harnessId: 'ghost', cwd: '/wt' });

      expect(collectUsage).not.toHaveBeenCalled();
      expect(verificationAttempts.setUsage).not.toHaveBeenCalled();
    });
  });
});
