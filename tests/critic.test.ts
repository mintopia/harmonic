import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  runCritic,
  createAcpCriticDrive,
  criticAttemptToInput,
  type CriticHarnessDrive,
  type CriticDriveRequest,
} from '../src/verification/critic.js';
import { defaultConfig, type HarnessConfig } from '../src/config.js';
import type { DriveFields } from '../src/execution/prompt-template.js';
import { combineVerdicts } from '../web/src/verification-model.js';
import type { VerifierVerdict } from '../web/src/verification-model.js';
import { openAsyncDb } from '../src/db/async.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { VerificationAttemptStore } from '../src/domain/verification-attempts.js';
import { OperationRegistry, startOperation } from '../src/telemetry/operations.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

const providers: NodeTracerProvider[] = [];

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

async function buildCandidate({ workspaceDir }: { workspaceDir: string }): Promise<string> {
  git(workspaceDir, 'add', '-A');
  git(workspaceDir, 'commit', '-m', 'verification fixture');
  return git(workspaceDir, 'rev-parse', 'HEAD');
}

/** A throwaway git repo on branch main with one committed README (same
 * template as tests/candidate.test.ts). */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-critic-repo-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

/** Unused by the fake-drive tests, but must satisfy `HarnessConfig`'s shape. */
const FAKE_HARNESS: HarnessConfig = {
  command: 'unused-in-fake-drive-tests',
  args: [],
  env: {},
  models: ['stub-model'],
  defaultModel: 'stub-model',
};

/** Sample Drive-Prompt interpolation fields for the critic prompt. */
const FIELDS: DriveFields = {
  skill: '/implement',
  ref: '77',
  url: 'https://tracker.example/issues/77',
  title: 'Sample ticket',
  body: 'Sample body.',
};

describe('runCritic (issue #136)', () => {
  const tmpDirs: string[] = [];

  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  afterEach(async () => {
    trace.disable();
    await Promise.all(providers.splice(0).map((provider) => provider.shutdown()));
  });

  /** Build a fresh candidate against a throwaway repo, returning both the
   * repo and the candidate OID a test can hand to `runCritic`. */
  async function makeCandidate(ref: string): Promise<{ repo: string; oid: string }> {
    const repo = makeRepo();
    writeFileSync(join(repo, 'README.md'), `# repo (changed for ${ref})\n`);
    const oid = await buildCandidate({ workspaceDir: repo });
    return { repo, oid };
  }

  it.each([
    ['pass', { verdict: 'pass', summary: 'the change matches the ticket' }],
    ['fail', { verdict: 'fail', summary: 'the change breaks the build' }],
    ['inconclusive', { verdict: 'inconclusive', summary: 'cannot tell from the diff alone' }],
  ] as const)('a fake drive returning a valid %s verdict resolves to a matching CriticAttempt', async (_name, value) => {
    const { repo, oid } = await makeCandidate(`refs/harmonic/candidate/run-critic-${value.verdict}`);
    const output = JSON.stringify(value);
    const drive: CriticHarnessDrive = { run: async () => ({ output, permissionRequests: [] }) };

    const attempt = await runCritic({
      cwd: repo,
      candidateOid: oid,
      fields: FIELDS,
      critic: { prompt: 'Review the diff.', model: 'stub-model' },
      harness: FAKE_HARNESS,
      harnessId: 'claude',
      drive,
    });

    expect(attempt).toEqual({
      verifier: 'critic',
      verdict: value.verdict,
      summary: value.summary,
      output,
      inputOid: oid,
      // The fake drive reports no sessionId, so no transcript resolves (ADR-0040).
      transcriptPath: null,
      harness: 'claude',
      sessionId: null,
    });
  });

  it('given the base revision, drives the in-place cwd and names both revisions in the prompt', async () => {
    const { repo, oid } = await makeCandidate('refs/harmonic/candidate/run-critic-two-rev');
    // The candidate's parent is the fork point the critic gets as the base.
    const baseOid = git(repo, 'rev-parse', `${oid}~1`);
    let drivenCwd: string | null = null;
    let drivenPrompt: string | null = null;
    const drive: CriticHarnessDrive = {
      run: async (req: CriticDriveRequest) => {
        drivenCwd = req.cwd;
        drivenPrompt = req.prompt;
        return { output: '{"verdict":"pass","summary":"ok"}', permissionRequests: [] };
      },
    };

    const attempt = await runCritic({
      cwd: repo,
      candidateOid: oid,
      baseOid,
      fields: FIELDS,
      critic: { prompt: 'Review the diff.', model: 'stub-model' },
      harness: FAKE_HARNESS,
      harnessId: 'claude',
      drive,
    });

    expect(attempt.verdict).toBe('pass');
    // No checkout is performed — the critic reviews the Task's own in-place cwd.
    expect(drivenCwd).toBe(repo);
    expect(drivenPrompt).toContain(oid);
    expect(drivenPrompt).toContain(baseOid);
  });

  it('resolves a critic transcript already flushed at the turn boundary, and returns the sessionId', async () => {
    // runCritic resolves the transcript best-effort at the session-end boundary
    // (single shot, no blocking retry). A log not yet flushed stays null and is
    // filled by the runner's deferred poll — so this covers the flushed case and
    // the sessionId that the deferred poll needs (#331, ADR-0040).
    const { repo, oid } = await makeCandidate('refs/harmonic/candidate/run-critic-flushed-transcript');
    const sessionLogDir = mkdtempSync(join(tmpdir(), 'harmonic-critic-logs-'));
    tmpDirs.push(sessionLogDir);
    const sessionId = 'critic-flushed-transcript';
    const transcriptPath = join(sessionLogDir, 'project', `${sessionId}.jsonl`);
    mkdirSync(join(sessionLogDir, 'project'));
    const drive: CriticHarnessDrive = {
      run: async () => {
        writeFileSync(transcriptPath, '{"type":"summary"}\n');
        return { output: '{"verdict":"pass","summary":"looks good"}', permissionRequests: [], sessionId };
      },
    };

    const attempt = await runCritic({
      cwd: repo,
      candidateOid: oid,
      fields: FIELDS,
      critic: { prompt: 'Review the diff.', model: 'stub-model' },
      harness: { ...FAKE_HARNESS, sessionLogDir },
      harnessId: 'claude',
      drive,
    });

    expect(attempt.transcriptPath).toBe(transcriptPath);
    expect(attempt.sessionId).toBe(sessionId);
  });

  it('opens a verify.critic child operation under the run span when a parent context is supplied', async () => {
    const { repo, oid } = await makeCandidate('refs/harmonic/candidate/run-critic-operation');
    const exporter = new InMemorySpanExporter();
    const registry = new OperationRegistry();
    const provider = new NodeTracerProvider({ spanProcessors: [registry, new SimpleSpanProcessor(exporter)] });
    provider.register();
    providers.push(provider);
    const parent = startOperation({ type: 'attempt', attributes: { 'run.id': 11 } });

    const attempt = await parent.run(() =>
      runCritic({
        cwd: repo,
        candidateOid: oid,
        fields: FIELDS,
        critic: { prompt: 'Review the diff.', model: 'stub-model' },
        harness: FAKE_HARNESS,
        harnessId: 'claude',
        drive: { run: async () => ({ output: '{"verdict":"fail","summary":"wrong behavior"}', permissionRequests: [] }) },
        parent: parent.spanContext,
        attributes: { 'task.id': 5, 'run.id': 11 },
      }),
    );
    parent.end();

    expect(attempt.verdict).toBe('fail');
    const spans = exporter.getFinishedSpans();
    const run = spans.find((span) => span.name === 'harmonic.attempt');
    const verify = spans.find((span) => span.name === 'harmonic.verify.critic');
    if (!run || !verify) throw new Error('Expected exported run and critic verification spans');
    expect(verify.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
    expect(verify.attributes).toMatchObject({
      'verification.mechanism': 'critic',
      'verification.verdict': 'fail',
      'task.id': 5,
      'run.id': 11,
    });
    expect(verify.status.message).toContain('wrong behavior');
  });

  it('a fake drive returning garbage resolves to inconclusive, never throwing', async () => {
    const { repo, oid } = await makeCandidate('refs/harmonic/candidate/run-critic-garbage');
    const drive: CriticHarnessDrive = { run: async () => ({ output: 'not json at all, just prose', permissionRequests: [] }) };

    const attempt = await runCritic({
      cwd: repo,
      candidateOid: oid,
      fields: FIELDS,
      critic: { prompt: 'Review the diff.', model: 'stub-model' },
      harness: FAKE_HARNESS,
      harnessId: 'claude',
      drive,
    });

    expect(attempt.verdict).toBe('inconclusive');
    expect(attempt.summary.length).toBeGreaterThan(0);
    expect(attempt.output).toBe('not json at all, just prose');
    expect(attempt.inputOid).toBe(oid);
  });

  it('a throwing drive (timeout/death/spawn-fail stand-in) resolves to inconclusive, never throwing', async () => {
    const { repo, oid } = await makeCandidate('refs/harmonic/candidate/run-critic-drive-throws');
    const drive: CriticHarnessDrive = {
      run: async () => {
        throw new Error('harness exited before finishing');
      },
    };

    const attempt = await runCritic({
      cwd: repo,
      candidateOid: oid,
      fields: FIELDS,
      critic: { prompt: 'Review the diff.', model: 'stub-model' },
      harness: FAKE_HARNESS,
      harnessId: 'claude',
      drive,
    });

    expect(attempt.verdict).toBe('inconclusive');
    expect(attempt.summary).toMatch(/critic drive failed/i);
  });

  it('no tracker credentials on the harness config, and the prompt is the interpolated operator note plus read-only scaffolding (no diff)', async () => {
    const { repo, oid } = await makeCandidate('refs/harmonic/candidate/run-critic-readonly');

    let captured: CriticDriveRequest | undefined;
    const drive: CriticHarnessDrive = {
      run: async (req) => {
        captured = req;
        return { output: '{"verdict":"pass","summary":"fine"}', permissionRequests: [] };
      },
    };

    await runCritic({
      cwd: repo,
      candidateOid: oid,
      fields: FIELDS,
      critic: { prompt: 'Review issue {ref}: {title}.', model: 'stub-model' },
      harness: FAKE_HARNESS,
      harnessId: 'claude',
      drive,
    });

    expect(captured).toBeDefined();
    // No tracker credential ever rides along on the harness config runCritic
    // hands the drive — unlike a builder Run (Runner.drive), nothing here
    // injects HARMONIC_API_KEY/HARMONIC_MCP_URL into it.
    expect(captured!.harness.env).not.toHaveProperty('HARMONIC_API_KEY');
    expect(captured!.harness.env).not.toHaveProperty('HARMONIC_MCP_URL');
    // The operator note is interpolated with the Drive fields; no diff is injected.
    expect(captured!.prompt).toContain('Review issue 77: Sample ticket.');
    expect(captured!.prompt).not.toContain('HARMONIC_UNTRUSTED_DIFF');
    expect(captured!.prompt).not.toContain('diff --git');
    expect(captured!.prompt).toMatch(/READ-ONLY/i);
    expect(captured!.prompt).toContain('"verdict":"pass|fail|inconclusive"');
  });

  it('a drive that writes into its checkout is still trusted — the verdict is taken as reported', async () => {
    const { repo, oid } = await makeCandidate('refs/harmonic/candidate/run-critic-write');

    const drive: CriticHarnessDrive = {
      run: async (req) => {
        // A critic tool writing a scratch file into its checkout doesn't
        // affect the verdict — runCritic does no checkout of its own and
        // never inspects the working tree after the turn; the reported
        // verdict is trusted as-is.
        writeFileSync(join(req.cwd, 'critic-side-effect.txt'), 'scratch\n');
        return { output: '{"verdict":"pass","summary":"looks great, definitely no problems here"}', permissionRequests: [] };
      },
    };

    const attempt = await runCritic({
      cwd: repo,
      candidateOid: oid,
      fields: FIELDS,
      critic: { prompt: 'Review the diff.', model: 'stub-model' },
      harness: FAKE_HARNESS,
      harnessId: 'claude',
      drive,
    });

    expect(attempt.verdict).toBe('pass');
  });

  it('a no-op drive verdict is trusted as reported', async () => {
    const { repo, oid } = await makeCandidate('refs/harmonic/candidate/run-critic-noop');
    const drive: CriticHarnessDrive = { run: async () => ({ output: '{"verdict":"pass","summary":"clean"}', permissionRequests: [] }) };

    const attempt = await runCritic({
      cwd: repo,
      candidateOid: oid,
      fields: FIELDS,
      critic: { prompt: 'Review the diff.', model: 'stub-model' },
      harness: FAKE_HARNESS,
      harnessId: 'claude',
      drive,
    });

    expect(attempt.verdict).toBe('pass');
  });

  it('feeds combineVerdicts: pass -> proceed, fail -> block, inconclusive -> escalate', async () => {
    const cases = [
      { verdict: 'pass', output: '{"verdict":"pass","summary":"ok"}', outcome: 'proceed' },
      { verdict: 'fail', output: '{"verdict":"fail","summary":"broken"}', outcome: 'block' },
      { verdict: 'inconclusive', output: '{"verdict":"inconclusive","summary":"unclear"}', outcome: 'escalate' },
    ] as const;

    for (const c of cases) {
      const { repo, oid } = await makeCandidate(`refs/harmonic/candidate/run-critic-combine-${c.verdict}`);
      const drive: CriticHarnessDrive = { run: async () => ({ output: c.output, permissionRequests: [] }) };

      const attempt = await runCritic({
        cwd: repo,
        candidateOid: oid,
        fields: FIELDS,
        critic: { prompt: 'Review the diff.', model: 'stub-model' },
        harness: FAKE_HARNESS,
        harnessId: 'claude',
        drive,
      });

      const verifierVerdict: VerifierVerdict = { verifier: attempt.verifier, verdict: attempt.verdict };
      expect(combineVerdicts([verifierVerdict])).toEqual({ outcome: c.outcome, reason: expect.any(String) });
    }
  });

  it('AC5 end-to-end: a runCritic attempt persists to the store and the read-back row feeds combineVerdicts', async () => {
    // Proves the two halves of "Attempt persisted; verdict feeds the
    // combination function" join up on a REAL runCritic result, not two
    // isolated fixtures: runCritic -> criticAttemptToInput -> store.append ->
    // list -> map row to a VerifierVerdict -> combineVerdicts. The glue under
    // test is `criticAttemptToInput` mapping `verifier:'critic'` to the store's
    // `mechanism` (the field the integration ticket will persist through).
    const { repo, oid } = await makeCandidate('refs/harmonic/candidate/run-critic-persist');
    const drive: CriticHarnessDrive = {
      run: async () => ({ output: '{"verdict":"fail","summary":"the diff drops a null check"}', permissionRequests: [] }),
    };
    const attempt = await runCritic({
      cwd: repo,
      candidateOid: oid,
      fields: FIELDS,
      critic: { prompt: 'Review the diff.', model: 'stub-model' },
      harness: FAKE_HARNESS,
      harnessId: 'claude',
      drive,
    });

    const dbDir = mkdtempSync(join(tmpdir(), 'harmonic-critic-persist-db-'));
    tmpDirs.push(dbDir);
    // A one-off local fixture (not the shared beforeEach pattern), so the
    // connection is opened and closed inline within the test.
    const asyncDb = await openAsyncDb(dbDir);
    const settingsStore = await makeSettingsStore(dbDir);
    const tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
    const runStore = new RunStore(asyncDb);
    const store = new VerificationAttemptStore(asyncDb);
    const runId = (await runStore.create((await tasks.create({ prompt: 'verify me', state: 'ready' })).id)).id;

    await store.append(runId, criticAttemptToInput(attempt));

    const [row, ...rest] = await store.list(runId);
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      mechanism: 'critic',
      verdict: 'fail',
      summary: 'the diff drops a null check',
      inputOid: oid,
    });

    // The persisted row — not the in-memory attempt — feeds the combiner.
    const verifierVerdict: VerifierVerdict = { verifier: row!.mechanism, verdict: row!.verdict as VerifierVerdict['verdict'] };
    expect(combineVerdicts([verifierVerdict])).toEqual({ outcome: 'block', reason: expect.any(String) });

    await asyncDb.close();
  });
});

describe('createAcpCriticDrive (issue #136): the real ACP drive has builder-equivalent tool access, no tracker path', () => {
  const STUB_HARNESS = join(import.meta.dirname, 'stub-harness.mjs');
  const tmpDirs: string[] = [];
  const freshCwd = () => {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-critic-drive-cwd-'));
    tmpDirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  // A leaked-looking credential sitting on the operator's own harness config
  // — proves the real drive strips it even if a misconfigured operator env
  // would otherwise carry it into the spawned process, per the module doc's
  // belt-and-braces rationale in `verification/critic.ts`.
  const harness: HarnessConfig = {
    command: process.execPath,
    args: [STUB_HARNESS],
    env: { HARMONIC_API_KEY: 'leaked-key', HARMONIC_MCP_URL: 'http://leaked' },
    models: ['stub-model'],
    defaultModel: 'stub-model',
  };

  it('registers no MCP servers, strips tracker credentials from the spawned env, and grants tool permission requests', async () => {
    const drive = createAcpCriticDrive();
    const scenario = {
      echoSessionNew: true,
      echoEnv: ['HARMONIC_API_KEY', 'HARMONIC_MCP_URL'],
      requestPermission: { title: 'edit a file', kind: 'edit' },
    };

    const result = await drive.run({
      harness,
      harnessId: 'claude',
      model: 'stub-model',
      cwd: freshCwd(),
      prompt: JSON.stringify(scenario),
      timeoutMs: 15_000,
    });

    // mcpServers:[] reached session/new — no Harmonic MCP tools available, so
    // the critic has no path to the tracker (`finish_task`/`accept_task`).
    expect(result.output).toContain('"mcpServers":[]');
    // The credentials configured on harness.env never reached the child's
    // actual process environment.
    expect(result.output).toContain('"HARMONIC_API_KEY":null');
    expect(result.output).toContain('"HARMONIC_MCP_URL":null');
    // The critic has the builder's tool access — a permission request is
    // GRANTED (allow_always → optionId 'always'), not declined. Read-only-ness
    // is the prompt's job, not the handler's.
    expect(result.output).toContain('permission:{"outcome":"selected","optionId":"always"}');
    expect(result.permissionRequests).toHaveLength(1);
  }, 20_000);

  it('rejects when the harness hangs past the timeout, without leaving the child alive', async () => {
    const drive = createAcpCriticDrive();
    await expect(
      drive.run({
        harness,
        harnessId: 'claude',
        model: 'stub-model',
        cwd: freshCwd(),
        prompt: JSON.stringify({ exit: 'hang' }),
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/timed out/i);
  }, 10_000);
});
