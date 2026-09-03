import { spawn } from 'node:child_process';
import type { Attributes, SpanContext } from '@opentelemetry/api';
import type { HarnessConfig, VerificationCritic } from '../config.js';
import { AcpDriver } from '../acp/driver.js';
import { parsePermissionRequest, type PermissionRequest } from '../acp/permission-request.js';
import { adapterFor } from '../execution/harness/registry.js';
import type { DriveFields } from '../execution/prompt-template.js';
import { buildCriticPrompt } from './critic-prompt.js';
import { parseCriticOutput, type Verdict } from './critic-schema.js';
import type { VerificationAttemptInput } from '../domain/verification-attempts.js';
import { startOperation } from '../telemetry/operations.js';
import { logger } from '../logger.js';

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
}

/** The injectable seam between {@link runCritic} and an actual harness spawn. */
export interface CriticHarnessDrive {
  run(req: CriticDriveRequest): Promise<CriticDriveResult>;
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
export function createAcpCriticDrive(): CriticHarnessDrive {
  return {
    async run(req: CriticDriveRequest): Promise<CriticDriveResult> {
      const env = criticSpawnEnv(req.harness, req.harnessId, req.model, req.cwd);
      const child = spawn(req.harness.command, req.harness.args, {
        cwd: req.cwd,
        env: env as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

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

      const kill = (): void => {
        try {
          if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
        } catch {
        }
      };

      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          kill();
          reject(new Error(`critic drive timed out after ${req.timeoutMs}ms`));
        }, req.timeoutMs);
      });

      try {
        // Some harnesses (copilot) have no spawn-time model pin; `sessionModelId` fills it via `session/set_model`.
        const modelId = adapterFor(req.harnessId).sessionModelId?.(req.model);
        const sessionId = await Promise.race([driver.handshake({ cwd: req.cwd, mcpServers: [], modelId }), timeout]);

        const mode = adapterFor(req.harnessId).unattendedPermissionMode(driver.availableModes);
        if (mode) {
          await Promise.race([driver.setMode(mode), timeout]);
        }

        await Promise.race([driver.prompt([{ type: 'text', text: req.prompt }]), timeout]);
        return { output, permissionRequests, sessionId: sessionId ?? null };
      } finally {
        if (timer) clearTimeout(timer);
        driver.dispose();
        kill();
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
  critic: VerificationCritic;
  /** The Drive-Prompt interpolation tokens filled into the operator's review prompt. */
  fields: DriveFields;
  harness: HarnessConfig;
  harnessId: string;
  /** Injectable drive seam; defaults to {@link createAcpCriticDrive}. */
  drive?: CriticHarnessDrive;
  /** Hard bound on the single prompt turn; generous default for a review. */
  timeoutMs?: number;
  parent?: SpanContext;
  attributes?: Attributes;
  /** Each ACP `session/update` from the critic turn, verbatim, for a live
   * transcript that renders exactly like the builder's. */
  onUpdate?: (update: { sessionUpdate: string; [key: string]: unknown }) => void;
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
  /** The candidate OID this attempt verified. */
  inputOid: string;
  /** The critic's native transcript locator and the harness that wrote it; both null when unresolved. */
  transcriptPath: string | null;
  harness: string | null;
  /** The harness session id for this critic turn, for a deferred transcript re-resolve. */
  sessionId: string | null;
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

async function runCriticUnchecked(args: RunCriticArgs): Promise<CriticAttempt> {
  const drive = args.drive ?? createAcpCriticDrive();
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let verdict: Verdict = 'inconclusive';
  let summary = '';
  let output = '';
  let sessionId: string | null = null;

  const prompt = buildCriticPrompt({
    operatorPrompt: args.critic.prompt,
    fields: args.fields,
    verifiedHeadOid: args.verifiedHeadOid,
    ...(args.baseOid ? { baseOid: args.baseOid } : {}),
  });
  try {
    const result = await drive.run({
      harness: args.harness,
      harnessId: args.harnessId,
      model: args.critic.model,
      cwd: args.cwd,
      prompt,
      timeoutMs,
      ...(args.onUpdate ? { onUpdate: args.onUpdate } : {}),
    });
    output = result.output;
    sessionId = result.sessionId ?? null;
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

  let transcriptPath: string | null = null;
  if (sessionId) {
    try {
      transcriptPath =
        (await adapterFor(args.harnessId).usage?.resolveTranscriptPath?.({
          sessionLogDir: args.harness.sessionLogDir,
          sessionId,
        })) ?? null;
    } catch {
      transcriptPath = null;
    }
  }

  return {
    verifier: 'critic',
    verdict,
    summary,
    output,
    prompt,
    inputOid: args.verifiedHeadOid,
    transcriptPath,
    harness: args.harnessId,
    sessionId,
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
    prompt: attempt.prompt,
    transcriptPath: attempt.transcriptPath,
    harness: attempt.harness,
  };
}
