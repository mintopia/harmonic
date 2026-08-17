import { spawn } from 'node:child_process';
import type { HarnessConfig, VerificationCritic } from '../config.js';
import { AcpDriver } from '../acp/driver.js';
import { adapterFor } from '../execution/harness/adapter.js';
import { withDetachedWorktree } from '../execution/candidate.js';
import { Git } from '../execution/git.js';
import { buildCriticPrompt, newNonce } from './critic-prompt.js';
import { parseCriticOutput, type Verdict } from './critic-schema.js';

/**
 * The agent critic (issue #136, ADR-0021, reliability-design Unit B): a
 * read-only reviewer Harness that judges a frozen candidate's diff and
 * returns a schema-validated {@link Verdict}. This module is a
 * self-contained, fully-tested unit invoked via `runCritic(...)` — the
 * integration ticket that wires it into the `verifying` phase of the live
 * Runner settle/landing path is out of scope here, matching how the sibling
 * substrate tickets #132 (config), #133 (`combineVerdicts`), and #134
 * (candidate snapshot) shipped as real-but-unwired units.
 *
 * Everything the critic sees is bracketed by `withDetachedWorktree`
 * (`execution/candidate.ts`, #134): the candidate OID is checked out into a
 * disposable detached worktree, and the before/after fingerprint proves
 * whether the "read-only" critic actually mutated anything. Belt-and-braces
 * with the ACP-level containment below (empty `mcpServers`, deny-all
 * permission handler) — either one failing is still caught by the other.
 */

/** What a drive of one critic turn produced. */
export interface CriticDriveResult {
  /** Every `agent_message_chunk` text piece, concatenated in arrival order
   * (mirrors how `usage.ts:activityLine` reads chunk text off `session/update`). */
  output: string;
  /** Every `session/request_permission` the harness asked during the turn,
   * verbatim — kept for audit even though every one of them is denied. */
  permissionRequests: unknown[];
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

/** Runner's `spawnHarness` env-overlay recipe (`execution/runner.ts:496-509`),
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
 * `execution/runner.ts:702-786`), and run exactly one read-only prompt turn.
 *
 * Containment, in the order reliability-design Unit B lists it:
 *
 * - **No credentials**: {@link criticSpawnEnv} strips the tracker env vars.
 * - **No tools**: `handshake({ mcpServers: [] })` — the harness never learns
 *   about the Harmonic MCP server (`finish_task`/`accept_task`/anything that
 *   could mutate the tracker), unlike a builder Run which registers it
 *   (`runner.ts:657-661`).
 * - **Deny-all permissions**: every `session/request_permission` is declined
 *   (`outcome: 'cancelled'`) regardless of the tool's claimed kind — a
 *   critic has no legitimate reason to write, execute, or fetch, so nothing
 *   is auto-approved the way the Runner's afk `'auto'`-mode path approves
 *   safe tools (`runner.ts:711-727`). Every other agent→client method
 *   (fs/terminal capability probes) returns `null`, advertising nothing —
 *   same as `runner.ts:729-730`.
 * - **Read-only permission mode**: `'auto'` is set if the harness offers it
 *   (informational — it changes what the harness *asks about*, not what gets
 *   *approved*, since the handler above denies every ask regardless); if no
 *   suitable mode is offered the turn still runs, because the deny-all
 *   handler is what actually enforces read-only, not the mode.
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
            // Deny every request outright, whatever kind the harness claims
            // for it — the critic has no legitimate mutating tool call.
            return { outcome: 'cancelled' };
          }
          // Advertise no fs/terminal capability; anything else gets null.
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
        await Promise.race([driver.handshake({ cwd: req.cwd, mcpServers: [], modelId }), timeout]);

        if (driver.availableModes.includes('auto')) {
          await Promise.race([driver.setMode('auto'), timeout]);
        }

        await Promise.race([driver.prompt([{ type: 'text', text: req.prompt }]), timeout]);
        return { output, permissionRequests };
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
  /** The frozen candidate commit (`execution/candidate.ts` `buildCandidate`, #134). */
  candidateOid: string;
  /** The commit the candidate was built against — the other end of the diff. */
  baseRev: string;
  /** Where to check out the disposable detached worktree for this attempt. */
  worktreePath: string;
  critic: VerificationCritic;
  harness: HarnessConfig;
  harnessId: string;
  /** Injectable drive seam; defaults to {@link createAcpCriticDrive}. */
  drive?: CriticHarnessDrive;
  /** Injectable nonce (tests); defaults to a fresh {@link newNonce}. */
  nonce?: string;
  /** Hard bound on the single prompt turn; generous default for a read-only review. */
  timeoutMs?: number;
}

export interface CriticAttempt {
  verifier: 'critic';
  verdict: Verdict;
  summary: string;
  /** The critic's raw agent output — the un-parsed text `parseCriticOutput` read. */
  output: string;
  /** Whether the critic mutated the disposable checkout it ran against. */
  mutated: boolean;
  /** The candidate OID this attempt verified. */
  inputOid: string;
}

/** Generous default for a single read-only review turn — long enough for a
 * slow model on a large diff, short enough that a hung harness doesn't park
 * verification indefinitely. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Diff text past this many characters is truncated before it reaches the
 * prompt — an unbounded diff could blow the context window or the stored
 * `output`/prompt size; the prompt itself notes the truncation so the critic
 * judges only what it was actually shown, rather than silently guessing at
 * a cut-off change. */
const DIFF_CHAR_CAP = 200_000;

/**
 * Run the agent critic against a candidate OID and resolve a
 * {@link CriticAttempt} (issue #136, reliability-design Unit B).
 *
 * 1. Checks the candidate out in a disposable detached worktree
 *    (`withDetachedWorktree`, #134), bracketed by the before/after
 *    fingerprint that proves whether the critic mutated anything.
 * 2. Computes the candidate's diff against `baseRev` (`Git.diffRange`),
 *    caps it at {@link DIFF_CHAR_CAP}, and builds the injection-contained
 *    prompt (`buildCriticPrompt`).
 * 3. Drives one turn (`drive.run`) and parses the result
 *    (`parseCriticOutput`); a parse failure resolves to `inconclusive` with
 *    the parser's reason, never a thrown error.
 * 4. If the drive itself throws — timeout, child death, spawn failure, or
 *    any other plumbing failure — that resolves to `inconclusive` too, with
 *    the error's message as the reason. Same for a failure setting up the
 *    worktree/computing the diff: this function is a `CriticAttempt`
 *    factory, not a thing that fails a Run.
 * 5. After the bracket closes: if the fingerprint shows the critic mutated
 *    the checkout (`proof.mutated`), the verdict is force-overridden to
 *    `inconclusive` regardless of what the critic said — a read-only critic
 *    that mutated the tree it was reviewing is not a critic whose answer can
 *    be trusted (fail-safe, ADR-0021) — while `mutated: true` is still
 *    reported so the caller can see the anomaly.
 *
 * Never throws for a verdict outcome: every failure mode above is folded
 * into an `inconclusive` `CriticAttempt`, not an exception.
 */
export async function runCritic(args: RunCriticArgs): Promise<CriticAttempt> {
  const drive = args.drive ?? createAcpCriticDrive();
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let verdict: Verdict = 'inconclusive';
  let summary = '';
  let output = '';

  let proof: { mutated: boolean };
  try {
    proof = await withDetachedWorktree(args.repoDir, args.candidateOid, args.worktreePath, async (dir) => {
      let diff: string;
      try {
        diff = await Git.diffRange(args.repoDir, args.baseRev, args.candidateOid);
      } catch (err) {
        summary = `could not compute the candidate diff: ${err instanceof Error ? err.message : String(err)}`;
        return;
      }

      const truncated = diff.length > DIFF_CHAR_CAP;
      if (truncated) diff = diff.slice(0, DIFF_CHAR_CAP);

      const operatorPrompt = truncated
        ? `${args.critic.prompt}\n\n(Note: the diff below was truncated to the first ${DIFF_CHAR_CAP} characters; judge only what you can see, and treat anything past the cut as unreviewed.)`
        : args.critic.prompt;
      const nonce = args.nonce ?? newNonce();
      const prompt = buildCriticPrompt({ operatorPrompt, diff, nonce });

      try {
        const result = await drive.run({
          harness: args.harness,
          harnessId: args.harnessId,
          model: args.critic.model,
          cwd: dir,
          prompt,
          timeoutMs,
        });
        output = result.output;
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
      mutated: false,
      inputOid: args.candidateOid,
    };
  }

  if (proof.mutated) {
    // Fail-safe (ADR-0021): a "read-only" critic that mutated the tree it
    // reviewed cannot be trusted, whatever verdict it returned.
    verdict = 'inconclusive';
  }

  return { verifier: 'critic', verdict, summary, output, mutated: proof.mutated, inputOid: args.candidateOid };
}
