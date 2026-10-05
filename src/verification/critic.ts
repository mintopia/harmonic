import { killProcessGroup, type SpawnProcessGroup } from '../execution/process-groups.js';
import { access } from 'node:fs/promises';
import type { Attributes, SpanContext } from '@opentelemetry/api';
import type { AppConfig, HarnessConfig } from '../config.js';
import { AcpDriver, type AcpInitializeResult } from '../acp/driver.js';
import { parsePermissionRequest, type PermissionRequest } from '../acp/permission-request.js';
import { adapterFor } from '../execution/harness/registry.js';
import type { DriveFields } from '../execution/prompt-template.js';
import { buildCriticPrompt } from './critic-prompt.js';
import { parseCriticOutput, type Verdict } from './critic-schema.js';
import type { VerificationAttemptInput } from '../domain/verification-attempts.js';
import { startOperation } from '../telemetry/operations.js';
import { logger } from '../logger.js';
import type { StepArchiveWriter } from '../archive/task-archive.js';

function grantOptionId(request: PermissionRequest): string | null {
  const options = request.options;
  const pick =
    options.find((o) => o.kind === 'allow_always') ?? options.find((o) => o.kind === 'allow_once') ?? options[0];
  return pick?.optionId ?? null;
}

/** What a drive of one critic turn produced. */
export interface CriticDriveResult {
  /** Every `agent_message_chunk` text piece, concatenated in arrival order. */
  output: string;
  /** Every `session/request_permission` the harness asked during the turn, verbatim. */
  permissionRequests: PermissionRequest[];
  /** The harness's own `sessionId` for this turn; absent/null if the handshake never yielded one. */
  sessionId?: string | null;
  /** Aggregate ACP usage for the prompt turn, when the harness reports it. */
  usage?: Record<string, unknown> | undefined;
}

export interface CriticDriveRequest {
  harness: HarnessConfig;
  harnessId: string;
  model: string;
  /** The directory the critic reviews in place, checked out at the candidate revision. */
  cwd: string;
  prompt: string;
  timeoutMs: number;
  /** Each ACP `session/update` from the critic turn, verbatim, for a live
   * transcript that renders exactly like the builder's. */
  onUpdate?: (update: { sessionUpdate: string; [key: string]: unknown }) => void;
  /** Called after ACP initialization and session creation. */
  onSessionCreated?: (sessionId: string, initialize: AcpInitializeResult) => Promise<void> | void;
  /** Reload this prior ACP session instead of starting a fresh one. */
  continueSessionId?: string;
  /** Elapsed ACP prompt time; the real drive reports zero if startup fails before a prompt. */
  onAgentDurationMs?: (durationMs: number) => Promise<void>;
}

/** The injectable seam between {@link runCritic} and an actual harness spawn. */
export interface CriticHarnessDrive {
  run(req: CriticDriveRequest): Promise<CriticDriveResult>;
}

export async function runTimedCriticDrive(
  drive: CriticHarnessDrive,
  req: CriticDriveRequest,
  record: (durationMs: number) => Promise<void>,
): Promise<CriticDriveResult> {
  const started = performance.now();
  let recorded = false;
  try {
    return await drive.run({
      ...req,
      onAgentDurationMs: async (ms) => {
        recorded = true;
        await record(ms);
      },
    });
  } finally {
    if (!recorded) await recordDurationBestEffort(record, Math.round(performance.now() - started));
  }
}

async function recordDurationBestEffort(record: ((durationMs: number) => Promise<void>) | undefined, durationMs: number): Promise<void> {
  try {
    await record?.(durationMs);
  } catch (err) {
    logger.warn('critic: recording agent duration failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

function criticSpawnEnv(
  harness: HarnessConfig,
  harnessId: string,
  model: string,
  cwd: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...harness.env,
    HARMONIC_MODEL: model,
    ...adapterFor(harnessId).spawnEnv({ model, cwd, sessionLogDir: harness.sessionLogDir }),
  };
  delete env.HARMONIC_API_KEY;
  delete env.HARMONIC_MCP_URL;
  return env;
}

/** The real critic drive: one ACP review turn with no MCP servers and the builder's unattended session mode; any permission request is granted. */
export function createAcpCriticDrive(spawnProcessGroup: SpawnProcessGroup): CriticHarnessDrive {
  return {
    async run(req: CriticDriveRequest): Promise<CriticDriveResult> {
      const env = criticSpawnEnv(req.harness, req.harnessId, req.model, req.cwd);
      const child = spawnProcessGroup(req.harness.command, req.harness.args, {
        cwd: req.cwd,
        env: env as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      }, `critic harness ${req.harnessId}`);

      let output = '';
      const permissionRequests: PermissionRequest[] = [];

      const driver = new AcpDriver(child, {
        onSessionUpdate: (update) => {
          const u = update as { sessionUpdate?: string; content?: { type?: string; text?: unknown } };
          if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text' && typeof u.content.text === 'string') {
            output += u.content.text;
          }
          req.onUpdate?.(update);
        },
        onRequest: async (method, params) => {
          if (method === 'session/request_permission') {
            const request = parsePermissionRequest(params);
            if (!request) {
              logger.warn('acp: rejected malformed permission request', { harness: req.harnessId, critic: true });
              return { outcome: 'cancelled' };
            }
            permissionRequests.push(request);
            const optionId = grantOptionId(request);
            return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
          }
          return null;
        },
      });

      const kill = (): void => killProcessGroup(child);

      let timer: NodeJS.Timeout | undefined;
      let agentTimingRecorded = false;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          kill();
          reject(new Error(`critic drive timed out after ${req.timeoutMs}ms`));
        }, req.timeoutMs);
      });

      try {
        // Some harnesses (copilot) have no spawn-time model pin; `sessionModelId` fills it via `session/set_model`.
        const modelId = adapterFor(req.harnessId).sessionModelId?.(req.model);
        let initialize: AcpInitializeResult | undefined;
        let sessionId: string;
        if (req.continueSessionId) {
          const loaded = await Promise.race([driver.load({ sessionId: req.continueSessionId, cwd: req.cwd, mcpServers: [], modelId, onInitialize: (result) => { initialize = result; } }), timeout]);
          if (loaded.loaded) sessionId = req.continueSessionId;
          else sessionId = await Promise.race([driver.handshake({ cwd: req.cwd, mcpServers: [], modelId, onInitialize: (result) => { initialize = result; } }), timeout]);
        } else {
          sessionId = await Promise.race([driver.handshake({ cwd: req.cwd, mcpServers: [], modelId, onInitialize: (result) => { initialize = result; } }), timeout]);
        }
        if (initialize && sessionId !== req.continueSessionId) await req.onSessionCreated?.(sessionId, initialize);

        const mode = adapterFor(req.harnessId).unattendedPermissionMode(driver.availableModes, req.harness.permissionMode);
        if (mode) {
          await Promise.race([driver.setMode(mode), timeout]);
        }

        const promptStarted = performance.now();
        let promptResult: Awaited<ReturnType<AcpDriver['prompt']>>;
        try {
          promptResult = await Promise.race([driver.prompt([{ type: 'text', text: req.prompt }]), timeout]);
        } finally {
          agentTimingRecorded = true;
          await recordDurationBestEffort(req.onAgentDurationMs, Math.round(performance.now() - promptStarted));
        }
        return { output, permissionRequests, sessionId: sessionId ?? null, ...(promptResult.usage ? { usage: promptResult.usage } : {}) };
      } finally {
        if (timer) clearTimeout(timer);
        driver.dispose();
        kill();
        if (!agentTimingRecorded) await recordDurationBestEffort(req.onAgentDurationMs, 0);
      }
    },
  };
}

export interface RunCriticArgs {
  /** The directory the critic reviews in place, checked out at {@link verifiedHeadOid}. */
  cwd: string;
  /** The candidate revision under review; recorded as the attempt's `inputOid`. */
  verifiedHeadOid: string;
  /** The base revision the candidate diverged from; omitted ⇒ the critic reviews the candidate alone. */
  baseOid?: string;
  /** True when the worktree still carries uncommitted work pending a pre-merge commit. */
  dirty?: boolean;
  critic: { prompt: string; model: string; harness?: string };
  fragments: AppConfig['promptFragments'];
  /** The Drive-Prompt interpolation tokens filled into the operator's review prompt. */
  fields: DriveFields;
  harness: HarnessConfig;
  harnessId: string;
  drive: CriticHarnessDrive;
  /** Hard bound on the single prompt turn; generous default for a review. */
  timeoutMs?: number;
  parent?: SpanContext;
  attributes?: Attributes;
  /** Each ACP `session/update` from the critic turn, verbatim, for a live
   * transcript that renders exactly like the builder's. */
  onUpdate?: (update: { sessionUpdate: string; [key: string]: unknown }) => void;
  /** Receives the prompt, the ACP update stream and the native transcript for the Archive. */
  archive?: StepArchiveWriter;
  transcriptRetryDelaysMs?: number[];
  onAgentDurationMs?: (durationMs: number) => Promise<void>;
}

export interface CriticAttempt {
  verifier: 'critic';
  verdict: Verdict;
  summary: string;
  /** The critic's raw agent output — the un-parsed text `parseCriticOutput` read. */
  output: string;
  /** The exact prompt sent to the critic (`buildCriticPrompt`), persisted so the
   * Review tab can show what the reviewer was actually asked. */
  prompt: string;
  /** Archive locator of the Resolved Prompt, only when the archive write succeeded. */
  promptKey: string | null;
  /** The candidate OID this attempt verified. */
  inputOid: string;
  /** The critic's native transcript locator and the harness that wrote it; both null when unresolved. */
  transcriptPath: string | null;
  harness: string | null;
  /** The harness session id for this critic turn, for a deferred transcript re-resolve. */
  sessionId: string | null;
  /** Aggregate ACP usage returned with the critic prompt response, when available. */
  usage?: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Run the agent critic in place and resolve a {@link CriticAttempt}. Never throws for a verdict outcome: parse and drive failures fold into `inconclusive`. */
export async function runCritic(args: RunCriticArgs): Promise<CriticAttempt> {
  const operation = args.parent
    ? startOperation({ type: 'verify.critic', parent: args.parent, attributes: { 'verification.mechanism': 'critic', ...args.attributes } })
    : undefined;
  try {
    const attempt = operation ? await operation.run(() => runCriticUnchecked(args)) : await runCriticUnchecked(args);
    operation?.update({ 'verification.verdict': attempt.verdict });
    if (attempt.verdict === 'pass') operation?.end();
    else operation?.fail(attempt.summary);
    return attempt;
  } catch (error) {
    operation?.fail(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

const NATIVE_LOG_FLUSH_RETRY_DELAYS_MS = [100, 500, 2_000];

async function resolveTranscriptWithRetry(args: RunCriticArgs, sessionId: string): Promise<string | null> {
  const resolver = adapterFor(args.harnessId).usage?.resolveTranscriptPath;
  if (!resolver) return null;
  const delays = args.transcriptRetryDelaysMs ?? NATIVE_LOG_FLUSH_RETRY_DELAYS_MS;
  let resolved: string | null = null;
  for (let i = 0; i <= delays.length; i++) {
    if (i > 0) await new Promise<void>((resolve) => setTimeout(resolve, delays[i - 1]));
    try {
      resolved = (await resolver({ sessionLogDir: args.harness.sessionLogDir, sessionId })) ?? null;
    } catch (err) {
      logger.debug('critic: failed to resolve transcript path', { harness: args.harnessId, sessionId, error: err instanceof Error ? err.message : String(err) });
      resolved = null;
    }
    if (resolved && (await access(resolved).then(() => true, () => false))) return resolved;
  }
  logger.warn('critic: transcript not found after retries', { harness: args.harnessId, sessionId });
  return resolved;
}

async function runCriticUnchecked(args: RunCriticArgs): Promise<CriticAttempt> {
  const archive = args.archive;
  try {
    return await runCriticArchived(args, archive);
  } finally {
    if (archive) {
      try {
        await archive.close();
      } catch (err) {
        logger.warn('critic: archive close failed', { harness: args.harnessId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}

async function runCriticArchived(args: RunCriticArgs, archive: StepArchiveWriter | undefined): Promise<CriticAttempt> {
  const drive = args.drive;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let verdict: Verdict = 'inconclusive';
  let summary = '';
  let output = '';
  let sessionId: string | null = null;
  let usage: Record<string, unknown> | undefined;

  const prompt = buildCriticPrompt({
    operatorPrompt: args.critic.prompt,
    fields: args.fields,
    fragments: args.fragments,
    verifiedHeadOid: args.verifiedHeadOid,
    ...(args.baseOid ? { baseOid: args.baseOid } : {}),
    ...(args.dirty ? { dirty: args.dirty } : {}),
  });
  const promptKey = archive && (await archive.appendPrompt(prompt)) !== null ? archive.promptLocator : null;
  const onUpdate =
    archive || args.onUpdate
      ? (update: { sessionUpdate: string; [key: string]: unknown }): void => {
          archive?.appendUpdate(update);
          args.onUpdate?.(update);
        }
      : undefined;
  try {
    const request: CriticDriveRequest = {
      harness: args.harness,
      harnessId: args.harnessId,
      model: args.critic.model,
      cwd: args.cwd,
      prompt,
      timeoutMs,
      ...(onUpdate ? { onUpdate } : {}),
    };
    const result = args.onAgentDurationMs
      ? await runTimedCriticDrive(drive, request, args.onAgentDurationMs)
      : await drive.run(request);
    output = result.output;
    sessionId = result.sessionId ?? null;
    usage = result.usage;
    const parsed = parseCriticOutput(result.output);
    if (parsed.ok) {
      verdict = parsed.value.verdict;
      summary = parsed.value.summary;
    } else {
      summary = parsed.reason;
    }
  } catch (err) {
    summary = `critic drive failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const transcriptPath = sessionId ? await resolveTranscriptWithRetry(args, sessionId) : null;
  if (archive) {
    try {
      await archive.copyNative(args.harnessId, transcriptPath);
    } catch (err) {
      logger.warn('critic: archive native copy failed', { harness: args.harnessId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    verifier: 'critic',
    verdict,
    summary,
    output,
    prompt,
    promptKey,
    inputOid: args.verifiedHeadOid,
    transcriptPath,
    harness: args.harnessId,
    sessionId,
    ...(usage ? { usage } : {}),
  };
}

/** Map a {@link CriticAttempt} to the persisted {@link VerificationAttemptInput}. */
export function criticAttemptToInput(attempt: CriticAttempt): VerificationAttemptInput {
  return {
    mechanism: attempt.verifier,
    inputOid: attempt.inputOid,
    verdict: attempt.verdict,
    summary: attempt.summary,
    output: attempt.output,
    transcriptPath: attempt.transcriptPath,
    harness: attempt.harness,
    promptKey: attempt.promptKey,
  };
}
