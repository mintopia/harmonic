import { killProcessGroup, type SpawnProcessGroup } from '../execution/process-groups.js';
import type { HarnessConfig } from '../config.js';
import { AcpDriver, type AcpInitializeResult } from '../acp/driver.js';
import { parsePermissionRequest, type PermissionRequest } from '../acp/permission-request.js';
import { adapterFor } from '../execution/harness/registry.js';
import { logger } from '../logger.js';
import type { PodSession } from '../execution/pod-session.js';

function rejectOptionId(request: PermissionRequest): string | null {
  return (request.options.find((o) => o.kind === 'reject_once') ?? request.options.find((o) => o.kind === 'reject_always'))?.optionId ?? null;
}

function grantOptionId(request: PermissionRequest): string | null {
  const options = request.options;
  const pick =
    options.find((o) => o.kind === 'allow_always') ?? options.find((o) => o.kind === 'allow_once') ?? options[0];
  return pick?.optionId ?? null;
}

const READ_ONLY_PERMITTED_KINDS = new Set(['read', 'search', 'fetch', 'think', 'execute']);

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
  /** Refuse every permission request and never switch to the unattended mode; for sessions that must have no tool access. */
  denyPermissions?: boolean;
  /** Each ACP `session/update` from the critic turn, verbatim, for a live
   * transcript that renders exactly like the builder's. */
  onUpdate?: (update: { sessionUpdate: string; [key: string]: unknown }) => void;
  /** Called after ACP initialization and session creation. */
  onSessionCreated?: (sessionId: string, initialize: AcpInitializeResult) => Promise<void> | void;
  /** Reload this prior ACP session instead of starting a fresh one. */
  continueSessionId?: string;
  /** Deny every permission request that could write, and never switch the harness into its unattended permission mode. */
  readOnly?: boolean;
  pod?: PodSession;
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

function podSpawnEnv(req: CriticDriveRequest): Record<string, string> {
  const adapterEnv = adapterFor(req.harnessId).spawnEnv({ model: req.model, cwd: req.cwd, sessionLogDir: req.harness.sessionLogDir });
  const defined = Object.entries(adapterEnv).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return { HARMONIC_MODEL: req.model, ...Object.fromEntries(defined) };
}

/** The real critic drive: one ACP review turn with no MCP servers and the builder's unattended session mode; any permission request is granted. */
export function createAcpCriticDrive(spawnProcessGroup: SpawnProcessGroup): CriticHarnessDrive {
  return {
    async run(req: CriticDriveRequest): Promise<CriticDriveResult> {
      const child = req.pod
        ? await req.pod.spawnHarness(req.harness.command, req.harness.args, podSpawnEnv(req))
        : spawnProcessGroup(req.harness.command, req.harness.args, {
            cwd: req.cwd,
            env: criticSpawnEnv(req.harness, req.harnessId, req.model, req.cwd) as NodeJS.ProcessEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
          }, `critic harness ${req.harnessId}`);
      const podSecrets = req.pod?.credentialValues ?? [];
      const maskPod = (text: string): string => podSecrets.reduce((out, secret) => out.split(secret).join('***'), text);

      let output = '';
      const permissionRequests: PermissionRequest[] = [];

      const driver = new AcpDriver(child, {
        onSessionUpdate: (update) => {
          const u = update as { sessionUpdate?: string; content?: { type?: string; text?: unknown } };
          if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text' && typeof u.content.text === 'string') {
            output += u.content.text;
          }
          req.onUpdate?.(podSecrets.length === 0 ? update : (JSON.parse(maskPod(JSON.stringify(update))) as typeof update));
        },
        onRequest: async (method, params) => {
          if (method === 'session/request_permission') {
            const request = parsePermissionRequest(params);
            if (!request) {
              logger.warn('acp: rejected malformed permission request', { harness: req.harnessId, critic: true });
              return { outcome: 'cancelled' };
            }
            permissionRequests.push(request);
            if (req.readOnly && !READ_ONLY_PERMITTED_KINDS.has(request.toolCall.kind ?? '')) {
              const denied = rejectOptionId(request);
              return denied ? { outcome: 'selected', optionId: denied } : { outcome: 'cancelled' };
            }
            if (req.denyPermissions) {
              const rejectId = rejectOptionId(request);
              return rejectId ? { outcome: 'selected', optionId: rejectId } : { outcome: 'cancelled' };
            }
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

        const mode = req.readOnly || req.denyPermissions ? null : adapterFor(req.harnessId).unattendedPermissionMode(driver.availableModes, req.harness.permissionMode);
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
        return { output: maskPod(output), permissionRequests, sessionId: sessionId ?? null, ...(promptResult.usage ? { usage: promptResult.usage } : {}) };
      } finally {
        if (timer) clearTimeout(timer);
        driver.dispose();
        kill();
        if (!agentTimingRecorded) await recordDurationBestEffort(req.onAgentDurationMs, 0);
      }
    },
  };
}
