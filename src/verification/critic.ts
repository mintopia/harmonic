import { spawn } from 'node:child_process';
import type { Attributes, SpanContext } from '@opentelemetry/api';
import type { HarnessConfig, VerificationCritic } from '../config.js';
import { AcpDriver } from '../acp/driver.js';
import { adapterFor } from '../execution/harness/adapter.js';
import { afkSessionMode } from '../execution/afk-permissions.js';
import type { DriveFields } from '../execution/prompt-template.js';
import { buildCriticPrompt } from './critic-prompt.js';
import { parseCriticOutput, type Verdict } from './critic-schema.js';
import type { VerificationAttemptInput } from '../domain/verification-attempts.js';
import { startOperation } from '../telemetry/operations.js';

/** The option id that grants a permission request — `allow_always` preferred,
 * then `allow_once`, then anything. The critic runs unattended, so any
 * `session/request_permission` that still arrives is granted rather than left to
 * hang; read-only-ness is the prompt's job (ADR-0003), not the handler's. */
function grantOptionId(request: unknown): string | null {
  const options = ((request as { options?: unknown } | null)?.options ?? []) as { kind?: string; optionId?: string }[];
  const pick =
    options.find((o) => o.kind === 'allow_always') ?? options.find((o) => o.kind === 'allow_once') ?? options[0];
  return pick?.optionId ?? null;
}

/**
 * The agent critic (ADR-0003): a review agent that judges a Task's candidate the
 * way a human reviewer would and returns a schema-validated {@link Verdict}. This
 * module is a self-contained, fully-tested unit invoked via `runCritic(...)`,
 * wired into the Attempt's Review Step of the live Runner settle/merging path
 * (`runVerification` in `execution/runner.ts`) — where its verdict folds into
 * `combineVerdicts` alongside the command verifier, so a fail/inconclusive critic
 * blocks or escalates the Run.
 *
 * The critic **reviews in place** (ADR-0003): it runs against the Task's own
 * worktree (or the live checkout in direct mode) at the candidate revision, given
 * the base and candidate revisions so it can read the change itself with its own
 * tools — no disposable checkout, no injected diff, no index provisioning. There
 * is no enforcement machinery: restraint is by prompt instruction. Containment
 * that remains is the credential/tracker boundary, not tree isolation:
 *
 * - **No credentials**: {@link criticSpawnEnv} strips the tracker env vars.
 * - **No Harmonic MCP**: `handshake({ mcpServers: [] })` — the harness never
 *   learns about the Harmonic MCP server, so the critic cannot `finish_task`/
 *   `accept_task` or otherwise reach the tracker; it only returns a verdict.
 * - **Same unattended posture as the builder**: it uses the shared
 *   {@link afkSessionMode} to pick the same permissive session mode the builder
 *   Run gets, and grants any `session/request_permission` that still arrives
 *   ({@link grantOptionId}). There is no critic-specific permission forcing.
 */

/** What a drive of one critic turn produced. */
export interface CriticDriveResult {
  /** Every `agent_message_chunk` text piece, concatenated in arrival order
   * (mirrors how `usage.ts:activityLine` reads chunk text off `session/update`). */
  output: string;
  /** Every `session/request_permission` the harness asked during the turn,
   * verbatim — kept for audit even though every one of them is granted. */
  permissionRequests: unknown[];
  /** The harness's own `sessionId` for this turn (ADR-0005), used to resolve
   * the native transcript locator. Absent/null if the handshake never yielded
   * one (or for a fake drive that does not model a session). */
  sessionId?: string | null;
}

export interface CriticDriveRequest {
  harness: HarnessConfig;
  harnessId: string;
  model: string;
  /** The directory the critic reviews in place — the Task's worktree, or the
   * live checkout in direct mode — checked out at the candidate revision. */
  cwd: string;
  prompt: string;
  timeoutMs: number;
}

/**
 * The injectable seam between {@link runCritic} and an actual harness spawn.
 * `createAcpCriticDrive` is the real implementation; `tests/critic.test.ts`
 * substitutes a fake that returns canned output without spawning a process, so
 * the schema/prompt/verdict logic in `runCritic` is testable without a real ACP
 * harness on the test machine.
 */
export interface CriticHarnessDrive {
  run(req: CriticDriveRequest): Promise<CriticDriveResult>;
}

/** Runner's `spawnHarness` env-overlay recipe (`execution/runner.ts`),
 * minus any tracker credential. The critic never receives
 * `HARMONIC_API_KEY`/`HARMONIC_MCP_URL` — even though nothing here sets them
 * in the first place (unlike `Runner.drive`, which injects them into the
 * builder's workspace env for `finish_task`/`accept_task`), the `delete`
 * below is a deliberate, explicit belt-and-braces: whatever env the critic's
 * process inherits or a future refactor adds, these two keys never survive
 * into it, so a critic turn can never reach the Harmonic MCP server. */
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

/**
 * The real critic drive: spawn the configured harness, speak ACP over its
 * stdio (`AcpDriver`, same sequence the Runner uses at
 * `execution/runner.ts`), and run exactly one review prompt turn against the
 * in-place worktree.
 *
 * Containment, in order (ADR-0003):
 *
 * - **No credentials**: {@link criticSpawnEnv} strips the tracker env vars.
 * - **No Harmonic MCP**: `handshake({ mcpServers: [] })` — the harness never
 *   learns about the Harmonic MCP server, unlike a builder Run which registers
 *   it (`runner.ts`). The critic keeps its own harness-native tools (read,
 *   execute, fetch) but has no path to the tracker.
 * - **Same unattended posture as the builder**: {@link afkSessionMode} picks the
 *   same permissive session mode the builder gets, and any
 *   `session/request_permission` that still arrives is GRANTED
 *   ({@link grantOptionId}). Read-only-ness is the PROMPT's job
 *   (`buildCriticPrompt`), not withholding tools. Every other agent→client
 *   method (fs/terminal capability probes) returns `null`.
 *
 * Timeout and child death both reject the in-flight `handshake`/`prompt`
 * call — `AcpDriver` already races every request against child exit
 * (`driver.ts`'s `exited`/`race`); the timeout here additionally races
 * against a `setTimeout`, so a harness that hangs without dying still bounds
 * the critic turn.
 */
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
      const permissionRequests: unknown[] = [];

      const driver = new AcpDriver(child, {
        onSessionUpdate: (update) => {
          const u = update as { sessionUpdate?: string; content?: { type?: string; text?: unknown } };
          if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text' && typeof u.content.text === 'string') {
            output += u.content.text;
          }
        },
        onRequest: async (method, params) => {
          if (method === 'session/request_permission') {
            permissionRequests.push(params);
            const optionId = grantOptionId(params);
            return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
          }
          return null;
        },
      });

      const kill = (): void => {
        try {
          if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
        } catch {
          // already gone
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
        // No reliable spawn-time model pin for some harnesses (copilot) —
        // `sessionModelId` fills it via `session/set_model`; absent for the
        // rest, exactly mirroring the Runner's own handshake call.
        const modelId = adapterFor(req.harnessId).sessionModelId?.(req.model);
        const sessionId = await Promise.race([driver.handshake({ cwd: req.cwd, mcpServers: [], modelId }), timeout]);

        const mode = afkSessionMode(req.harnessId, driver.availableModes);
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
  /** The directory the critic reviews in place — the Task's worktree, or the
   * live checkout in direct mode — already checked out at {@link candidateOid}. */
  cwd: string;
  /** The candidate revision under review (the Task branch's current head, or the
   * direct-mode candidate). Named to the critic and recorded as the attempt's
   * `inputOid`; the critic reads it in place rather than from a checkout. */
  candidateOid: string;
  /** The base revision (fork point) the candidate diverged from — the "before"
   * of the change. Named to the critic so it derives what changed by comparing
   * the two revisions itself, never a git diff (the standing design contract).
   * Omitted ⇒ the critic reviews the candidate alone (the base is unknown, e.g.
   * a direct-mode Run with no branch to take a merge-base against). */
  baseOid?: string;
  critic: VerificationCritic;
  /** The Drive-Prompt interpolation tokens (`prompt-template.ts` `driveFields`) —
   * the ticket ref/url/title/body + skill filled into the operator's review
   * prompt so the critic can name and read the issue it validates against. */
  fields: DriveFields;
  harness: HarnessConfig;
  harnessId: string;
  /** Injectable drive seam; defaults to {@link createAcpCriticDrive}. */
  drive?: CriticHarnessDrive;
  /** Hard bound on the single prompt turn; generous default for a review. */
  timeoutMs?: number;
  parent?: SpanContext;
  attributes?: Attributes;
}

export interface CriticAttempt {
  verifier: 'critic';
  verdict: Verdict;
  summary: string;
  /** The critic's raw agent output — the un-parsed text `parseCriticOutput` read. */
  output: string;
  /** The candidate OID this attempt verified. */
  inputOid: string;
  /** The critic's native transcript locator + the harness that wrote it
   * (ADR-0003, "persisted by locator"), for the operator's on-demand
   * critic-session log. Both null when no session id was captured or the harness
   * resolves no transcript. */
  transcriptPath: string | null;
  harness: string | null;
  /** The harness session id for this critic turn (ADR-0005). Retained so the
   * runner can defer a non-blocking transcript re-resolve when the harness had
   * not flushed its `${sessionId}.jsonl` by the session-end boundary. */
  sessionId: string | null;
}

/** Generous default for a single review turn — long enough for a slow model on a
 * large change, short enough that a hung harness doesn't park verification
 * indefinitely. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Run the agent critic in place against the Task's worktree and resolve a
 * {@link CriticAttempt} (ADR-0003).
 *
 * 1. Builds the review prompt (`buildCriticPrompt`) from the operator's
 *    configured note — Drive-Prompt tokens interpolated from
 *    {@link RunCriticArgs.fields} — plus the restraint instruction, the
 *    untrusted-data warning, and the strict JSON verdict contract. The base and
 *    candidate revisions are named; no diff is injected — the critic reads the
 *    change itself with its own tools.
 * 2. Drives one turn (`drive.run`) in {@link RunCriticArgs.cwd} and parses the
 *    result (`parseCriticOutput`); a parse failure resolves to `inconclusive`
 *    with the parser's reason, never a thrown error.
 * 3. If the drive itself throws — timeout, child death, spawn failure, or any
 *    other plumbing failure — that resolves to `inconclusive` too, with the
 *    error's message as the reason.
 *
 * Never throws for a verdict outcome: every failure mode above is folded into an
 * `inconclusive` `CriticAttempt`, not an exception.
 */
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
    candidateOid: args.candidateOid,
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

  // Resolve the native transcript locator now the turn is done (ADR-0003): the
  // JSONL lives in the harness's session-log dir. Best-effort — an unresolved
  // path (harness with no usage parser, or log not yet flushed) stays null and
  // the operator sees "log unavailable".
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
    inputOid: args.candidateOid,
    transcriptPath,
    harness: args.harnessId,
    sessionId,
  };
}

/**
 * Map a {@link CriticAttempt} to the shape {@link VerificationAttemptInput}
 * that `VerificationAttemptStore.append` persists. The critic's
 * `verifier: 'critic'` tag is the store's `mechanism`; every other field maps
 * straight across. This is the one place the critic's in-memory result crosses
 * into the persisted log.
 */
export function criticAttemptToInput(attempt: CriticAttempt): VerificationAttemptInput {
  return {
    mechanism: attempt.verifier,
    inputOid: attempt.inputOid,
    verdict: attempt.verdict,
    summary: attempt.summary,
    output: attempt.output,
    transcriptPath: attempt.transcriptPath,
    harness: attempt.harness,
  };
}
