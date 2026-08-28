import { spawn } from 'node:child_process';
import type { Attributes, SpanContext } from '@opentelemetry/api';
import type { HarnessConfig, VerificationCritic } from '../config.js';
import { AcpDriver } from '../acp/driver.js';
import { adapterFor } from '../execution/harness/adapter.js';
import { withDetachedWorktree } from '../execution/detached-worktree.js';
import { indexWorktree, dropIndex } from '../execution/code-index.js';
import type { DriveFields } from '../execution/prompt-template.js';
import { buildCriticPrompt } from './critic-prompt.js';
import { parseCriticOutput, type Verdict } from './critic-schema.js';
import type { VerificationAttemptInput } from '../domain/verification-attempts.js';
import { startOperation } from '../telemetry/operations.js';

/**
 * ACP session modes the critic tries, in order, to get the SAME unattended tool
 * access the afk builder gets (issue #136, containment relaxed by the 2026-08
 * ADR-0021 amendment): the critic is an independent evaluator that may need to
 * execute tools (read files, grep, run a build) to judge the change — it is held
 * read-only by its PROMPT and by the mutation fingerprint (`runCritic`), not by
 * withholding tools. `bypassPermissions` (no callback) is preferred, then Claude's
 * `auto`; a request-gated harness (Codex) uses its full-access mode id instead
 * (`agent-full-access`, mirroring the Runner's `afkFullAccessMode`). */
const CRITIC_PERMISSION_MODES = ['bypassPermissions', 'auto'] as const;
const CRITIC_FULL_ACCESS_MODES: Partial<Record<string, string>> = { codex: 'agent-full-access' };

/** The best available permissive session mode for the critic, or undefined. */
function criticPermissionMode(harnessId: string, available: readonly string[]): string | undefined {
  return (
    CRITIC_PERMISSION_MODES.find((m) => available.includes(m)) ??
    (CRITIC_FULL_ACCESS_MODES[harnessId] && available.includes(CRITIC_FULL_ACCESS_MODES[harnessId]!)
      ? CRITIC_FULL_ACCESS_MODES[harnessId]
      : undefined)
  );
}

/** The option id that grants a permission request — `allow_always` preferred,
 * then `allow_once`, then anything. Mirrors the Runner builder's `grant()`
 * (`runner.ts`). A request-gated harness that still asks mid-turn is granted, so
 * the critic can execute tools; read-only-ness is the prompt's + the fingerprint's
 * job, not the handler's. */
function grantOptionId(request: unknown): string | null {
  const options = ((request as { options?: unknown } | null)?.options ?? []) as { kind?: string; optionId?: string }[];
  const pick =
    options.find((o) => o.kind === 'allow_always') ?? options.find((o) => o.kind === 'allow_once') ?? options[0];
  return pick?.optionId ?? null;
}

/**
 * The agent critic (issue #136, ADR-0021, reliability-design Unit B): a
 * read-only reviewer Harness that judges a frozen candidate's diff and
 * returns a schema-validated {@link Verdict}. This module is a
 * self-contained, fully-tested unit invoked via `runCritic(...)`, wired into
 * the `verifying` phase of the live Runner settle/merging path by issue #164
 * (`runVerification` in `execution/runner.ts`) — where its verdict folds into
 * `combineVerdicts` alongside the command verifier, so a fail/inconclusive
 * critic blocks or escalates the Run. The sibling substrate tickets #132
 * (config) and #133 (`combineVerdicts`) shipped as
 * real-but-unwired units the same way before their own integration merged.
 *
 * Everything the critic sees is bracketed by `withDetachedWorktree`
 * (`execution/detached-worktree.ts`): the fixed OID is checked out into a
 * disposable detached worktree that is torn down when the turn ends. The
 * critic is kept read-only by the ACP-level containment below (empty
 * `mcpServers`, deny-all permission handler).
 */

/** What a drive of one critic turn produced. */
export interface CriticDriveResult {
  /** Every `agent_message_chunk` text piece, concatenated in arrival order
   * (mirrors how `usage.ts:activityLine` reads chunk text off `session/update`). */
  output: string;
  /** Every `session/request_permission` the harness asked during the turn,
   * verbatim — kept for audit even though every one of them is denied. */
  permissionRequests: unknown[];
  /** The harness's own `sessionId` for this turn (ADR-0040), used to resolve
   * the native transcript locator. Absent/null if the handshake never yielded
   * one (or for a fake drive that does not model a session). */
  sessionId?: string | null;
}

export interface CriticDriveRequest {
  harness: HarnessConfig;
  harnessId: string;
  model: string;
  /** The disposable detached worktree the critic reviews from — never a live
   * checkout (see the module doc). */
  cwd: string;
  prompt: string;
  timeoutMs: number;
}

/**
 * The injectable seam between {@link runCritic} and an actual harness spawn
 * (issue #136's "injectable seam for tests"). `createAcpCriticDrive` is the
 * real implementation; `tests/critic.test.ts` substitutes a fake that
 * returns canned output without spawning a process, so the schema/prompt/
 * worktree/mutation-detection logic in `runCritic` is testable without a real
 * ACP harness on the test machine.
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
 * `execution/runner.ts`), and run exactly one read-only prompt turn.
 *
 * Containment, in the order reliability-design Unit B lists it:
 *
 * - **No credentials**: {@link criticSpawnEnv} strips the tracker env vars.
 * - **No Harmonic MCP**: `handshake({ mcpServers: [] })` — the harness never
 *   learns about the Harmonic MCP server (`finish_task`/`accept_task`/anything
 *   that could mutate the tracker), unlike a builder Run which registers it
 *   (`runner.ts`). The critic keeps its own harness-native tools (read,
 *   execute, fetch) but has no path to the tracker: it cannot close/accept a
 *   Task, only return a verdict.
 * - **Builder-equivalent tool access**: the critic gets the same unattended
 *   access the afk builder gets, so it can execute tools to judge the change.
 *   A permissive session mode is set ({@link criticPermissionMode}:
 *   `bypassPermissions`/`auto`, or Codex's `agent-full-access`), and any
 *   `session/request_permission` that still arrives is GRANTED
 *   ({@link grantOptionId}) rather than declined. Read-only-ness is enforced by
 *   the PROMPT (`buildCriticPrompt`) and the post-turn mutation fingerprint in
 *   {@link runCritic}, NOT by withholding tools. Every other agent→client method
 *   (fs/terminal capability probes) returns `null`.
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

        const mode = criticPermissionMode(req.harnessId, driver.availableModes);
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
  /** The base repo owning the candidate ref and object store. */
  repoDir: string;
  /** The fixed commit checked out into the disposable worktree the critic reads from. */
  candidateOid: string;
  /** The base revision (fork point) the candidate diverged from — the "before"
   * of the change. Indexed as its own jCodeMunch repo alongside the candidate so
   * the critic is given the two revisions and derives what changed by comparing
   * them, never a git diff (the standing design contract). Omitted ⇒ the critic
   * reviews the candidate alone (the base is unknown, e.g. a direct-mode Run with
   * no branch to take a merge-base against). */
  baseOid?: string;
  /** Where to check out the disposable detached worktree for this attempt. The
   * base revision is checked out alongside it at `${worktreePath}-base`. */
  worktreePath: string;
  critic: VerificationCritic;
  /** The Drive-Prompt interpolation tokens (`drive-prompt.ts` `driveFields`) —
   * the ticket ref/url/title/body + skill filled into the operator's review
   * prompt so the critic can name and read the issue it validates against. */
  fields: DriveFields;
  harness: HarnessConfig;
  harnessId: string;
  /** An operator's ad-hoc note for a Note-to-critic re-verification (issue
   * #191) — forwarded into {@link buildCriticPrompt}'s trusted preamble.
   * Omitted for the ordinary verify-gate invocation from `runVerification`. */
  operatorNote?: string;
  /** Runner-injected, read-only merge-cleanliness of the candidate against the
   * Run's base branch (`Git.mergeCleanliness`, computed in the base repo — never
   * this disposable worktree), forwarded verbatim into {@link buildCriticPrompt}'s
   * trusted preamble so the critic never has to run git to check it. Omitted when
   * the base branch is unknown or `merge-tree` could not be computed. */
  mergeCleanliness?: { baseBranch: string; clean: boolean; conflicts?: string };
  /** Injectable drive seam; defaults to {@link createAcpCriticDrive}. */
  drive?: CriticHarnessDrive;
  /** Hard bound on the single prompt turn; generous default for a read-only review. */
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
   * (ADR-0040), for the operator's on-demand critic-session log. Both null when
   * no session id was captured or the harness resolves no transcript. */
  transcriptPath: string | null;
  harness: string | null;
  /** The harness session id for this critic turn (ADR-0040). Retained so the
   * runner can defer a non-blocking transcript re-resolve when the harness had
   * not flushed its `${sessionId}.jsonl` by the session-end boundary. */
  sessionId: string | null;
}

/** Generous default for a single read-only review turn — long enough for a
 * slow model on a large diff, short enough that a hung harness doesn't park
 * verification indefinitely. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Run the agent critic against a candidate OID and resolve a
 * {@link CriticAttempt} (issue #136, reliability-design Unit B; containment
 * relaxed by the 2026-08 ADR-0021 amendment).
 *
 * 1. Checks the candidate out in a disposable detached worktree
 *    (`withDetachedWorktree`, #134), torn down when the turn ends.
 * 2. Builds the read-only review prompt (`buildCriticPrompt`) from the
 *    operator's configured note — Drive-Prompt tokens interpolated from
 *    {@link RunCriticArgs.fields} — plus the read-only + verdict scaffolding.
 *    No diff is injected: the critic reads the candidate checkout itself.
 * 3. Drives one turn (`drive.run`) and parses the result
 *    (`parseCriticOutput`); a parse failure resolves to `inconclusive` with
 *    the parser's reason, never a thrown error.
 * 4. If the drive itself throws — timeout, child death, spawn failure, or
 *    any other plumbing failure — that resolves to `inconclusive` too, with
 *    the error's message as the reason. Same for a failure setting up the
 *    worktree: this function is a `CriticAttempt` factory, not a thing that
 *    fails a Run.
 *
 * Never throws for a verdict outcome: every failure mode above is folded
 * into an `inconclusive` `CriticAttempt`, not an exception.
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

/**
 * Check out `baseOid` into a disposable worktree, index it as its own jCodeMunch
 * repo, and invoke `body` with that repo id (null when the base could not be
 * checked out or indexed). Best-effort: any failure setting up the base tree
 * degrades to `body(null)` — a candidate-only review — rather than throwing, so a
 * missing/broken base never fails the critic. The base index and worktree are
 * reaped when `body` resolves.
 */
async function withBaseWorktreeIndexed(
  repoDir: string,
  baseOid: string,
  worktreePath: string,
  body: (baseRepoId: string | null) => Promise<void>,
): Promise<void> {
  let ran = false;
  const run = async (baseRepoId: string | null): Promise<void> => {
    ran = true;
    await body(baseRepoId);
  };
  try {
    await withDetachedWorktree(repoDir, baseOid, worktreePath, async (baseDir) => {
      const baseRepoId = await indexWorktree(baseDir);
      try {
        await run(baseRepoId);
      } finally {
        if (baseRepoId) await dropIndex(baseRepoId);
      }
    });
  } catch {
    // Base checkout/index failed. If `body` never ran (the checkout itself
    // failed), fall back to a candidate-only review; if it already ran, a
    // base-worktree teardown error must not discard the verdict it produced.
    if (!ran) await run(null);
  }
}

async function runCriticUnchecked(args: RunCriticArgs): Promise<CriticAttempt> {
  const drive = args.drive ?? createAcpCriticDrive();
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let verdict: Verdict = 'inconclusive';
  let summary = '';
  let output = '';
  let sessionId: string | null = null;

  try {
    await withDetachedWorktree(args.repoDir, args.candidateOid, args.worktreePath, async (candidateDir) => {
      // Index the candidate checkout as its own jCodeMunch repo (`code-index.ts`)
      // so the critic's code-index queries hit THIS tree, not `.` resolving to
      // the canonical checkout on another branch. The index lives outside the
      // worktree, so it never trips the mutation fingerprint. Best-effort: null
      // ⇒ skip the injection.
      const candidateRepoId = await indexWorktree(candidateDir);

      // One read-only review turn, given the candidate checkout plus whichever
      // code-index repo ids we managed to build. Extracted so it runs identically
      // whether or not the base revision could be indexed alongside it.
      const review = async (baseRepoId: string | null): Promise<void> => {
        const prompt = buildCriticPrompt({
          operatorPrompt: args.critic.prompt,
          fields: args.fields,
          ...(args.operatorNote !== undefined ? { operatorNote: args.operatorNote } : {}),
          ...(args.mergeCleanliness !== undefined ? { mergeCleanliness: args.mergeCleanliness } : {}),
          ...(candidateRepoId ? { candidateRepoId } : {}),
          ...(baseRepoId ? { baseRepoId } : {}),
        });
        try {
          const result = await drive.run({
            harness: args.harness,
            harnessId: args.harnessId,
            model: args.critic.model,
            cwd: candidateDir,
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
      };

      try {
        // Hand the critic the two revisions: check out and index the base (fork
        // point) alongside the candidate, so it derives what the change did by
        // comparing the two indexed revisions rather than being fed a diff. Best-
        // effort and nested — a base checkout/index failure degrades to a
        // candidate-only review, never a failed critic.
        if (args.baseOid) {
          await withBaseWorktreeIndexed(args.repoDir, args.baseOid, `${args.worktreePath}-base`, review);
        } else {
          await review(null);
        }
      } finally {
        // Reap the candidate index whichever way the turn went; the worktree is
        // about to be torn down, so the index would otherwise dangle.
        if (candidateRepoId) await dropIndex(candidateRepoId);
      }
    });
  } catch (err) {
    // Setting up the disposable worktree itself failed (bad OID, git/FS
    // error) — a genuine infra failure, folded into inconclusive rather
    // than thrown, same as every other failure mode this function handles.
    return {
      verifier: 'critic',
      verdict: 'inconclusive',
      summary: `critic could not check out the candidate: ${err instanceof Error ? err.message : String(err)}`,
      output: '',
      inputOid: args.candidateOid,
      transcriptPath: null,
      harness: args.harnessId,
      sessionId: null,
    };
  }

  // Resolve the native transcript locator now the turn is done (ADR-0040): the
  // JSONL lives in the harness's session-log dir, outside the disposable
  // worktree, so it survives the bracket closing above. Best-effort — an
  // unresolved path (harness with no usage parser, or log not yet flushed)
  // stays null and the operator sees "log unavailable".
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
 * that `VerificationAttemptStore.append` persists (issue #136 AC: "Attempt
 * persisted; verdict feeds the combination function"). The critic's
 * `verifier: 'critic'` tag is the store's `mechanism`; every other field maps
 * straight across. This is the one place the critic's in-memory result crosses
 * into the persisted log — kept as a named, tested function (rather than an
 * inline object literal at the call site) so the #164 integration that wires
 * `runCritic` into the `verifying` phase persists through a path already proven
 * end-to-end (`tests/critic.test.ts`).
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
