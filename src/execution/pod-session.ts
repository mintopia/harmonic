import { randomBytes } from 'node:crypto';
import type { TaskExecution } from '../db/schema.js';
import { logger } from '../logger.js';
import { errorMessage } from '../error-handling.js';
import type { RepositoryPassService } from '../repository-proxy/pass-service.js';
import { repositoryPath } from '../repository-proxy/server.js';
import { POD_PASS_KEY, POD_WORKSPACE, podLabels, type PodApi, type PodExecResult } from './kubernetes-pods.js';

const START_TIMEOUT_MS = 180_000;
const GIT_TIMEOUT_MS = 300_000;
const GIT = 'g() { git -c "http.extraHeader=Authorization: Bearer ${HARMONIC_PASS}" "$@"; }';

export interface PodTarget {
  name: string;
  namespace: string;
  cpu: string;
  memory: string;
  repositoryProxyUrl: string;
}

export interface PodSessionSpec {
  taskId: number;
  target: PodTarget;
  image: string;
  source: TaskExecution['source'];
  codeRepository: string;
  baseBranch: string;
  branch: string;
}

export interface PodSessionDeps {
  api: PodApi;
  passes: Pick<RepositoryPassService, 'issue'>;
  onExecution: (execution: TaskExecution) => void | Promise<void>;
  workdir?: string;
  startTimeoutMs?: number;
  suffix?: () => string;
}

export interface Checkpoint {
  branch: string;
  sha: string | null;
  forced: boolean;
  unchanged: boolean;
  error?: string;
}

export type PodRebase =
  | { ok: true; baseSha: string }
  | { ok: false; conflict: boolean; detail: string; baseSha: string | null; conflictedFiles: string[] };

export const podName = (taskId: number, suffix: string): string => `harmonic-task-${taskId}-${suffix}`;

export class PodSession {
  private readonly api: PodApi;
  private readonly workdir: string;
  private readonly name: string;
  private readonly secretName: string;
  private remoteTip: string | null = null;
  private disposed = false;
  private created = false;
  private secretCreated = false;
  private queue: Promise<unknown> = Promise.resolve();
  private execution: TaskExecution;

  constructor(
    private readonly spec: PodSessionSpec,
    private readonly deps: PodSessionDeps,
  ) {
    this.api = deps.api;
    this.workdir = deps.workdir ?? `${POD_WORKSPACE}/repo`;
    this.name = podName(spec.taskId, deps.suffix?.() ?? randomBytes(2).toString('hex'));
    this.secretName = this.name;
    this.execution = { target: spec.target.name, podName: null, podState: 'pending', namespace: spec.target.namespace, image: spec.image, source: spec.source };
  }

  get podName(): string {
    return this.name;
  }

  private get env(): Record<string, string> {
    const { target, codeRepository, baseBranch, branch } = this.spec;
    return {
      HARMONIC_REMOTE: `${target.repositoryProxyUrl.replace(/\/+$/, '')}${repositoryPath(codeRepository)}`,
      HARMONIC_BASE: baseBranch,
      HARMONIC_BRANCH: branch,
    };
  }

  private async record(patch: Partial<TaskExecution>): Promise<void> {
    this.execution = { ...this.execution, ...patch };
    try {
      await this.deps.onExecution(this.execution);
    } catch (error) {
      logger.warn(`task ${this.spec.taskId}: recording the pod state failed: ${errorMessage(error)}`);
    }
  }

  async start(): Promise<void> {
    const { target, taskId, image, baseBranch, branch, codeRepository } = this.spec;
    try {
      const pass = await this.deps.passes.issue(target.name, { codeRepository, baseBranch, ticketBranch: branch });
      await this.api.createSecret(target.namespace, this.secretName, { [POD_PASS_KEY]: pass }, podLabels(taskId));
      this.secretCreated = true;
      await this.api.createPod({ name: this.name, namespace: target.namespace, secretName: this.secretName, image, cpu: target.cpu, memory: target.memory, taskId });
      this.created = true;
      await this.record({ podName: this.name, podState: 'pending' });
      await this.api.waitForRunning(target.namespace, this.name, this.deps.startTimeoutMs ?? START_TIMEOUT_MS);
      await this.record({ podState: 'running' });
      const cloned = await this.sh(
        `${GIT}
set -eu
mkdir -p "$W" && cd "$W"
git init -q
git remote add origin "$HARMONIC_REMOTE"
tip=$(g ls-remote origin "refs/heads/$HARMONIC_BRANCH")
g fetch -q origin "+refs/heads/$HARMONIC_BASE:refs/remotes/origin/$HARMONIC_BASE"
if [ -n "$tip" ]; then
  g fetch -q origin "+refs/heads/$HARMONIC_BRANCH:refs/remotes/origin/$HARMONIC_BRANCH"
  git checkout -q -B "$HARMONIC_BRANCH" "refs/remotes/origin/$HARMONIC_BRANCH"
else
  git checkout -q -B "$HARMONIC_BRANCH" "refs/remotes/origin/$HARMONIC_BASE"
fi
echo "\${tip%%[[:space:]]*}"`,
        { W: this.workdir },
      );
      if (cloned.code !== 0) throw new Error(`cloning through the Repository Proxy failed: ${(cloned.stderr || cloned.stdout).trim()}`);
      this.remoteTip = cloned.stdout.trim().split('\n').at(-1) || null;
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  private sh(script: string, env: Record<string, string> = {}, timeoutMs = GIT_TIMEOUT_MS): Promise<PodExecResult> {
    return this.api.exec(this.spec.target.namespace, this.name, ['sh', '-c', script], { env: { ...this.env, ...env }, timeoutMs });
  }

  /** Runs a step's script in the repository checkout; the pass is available to it as the pod's `HARMONIC_PASS`. */
  run(script: string, env: Record<string, string>, timeoutMs: number): Promise<PodExecResult> {
    return this.api.exec(this.spec.target.namespace, this.name, ['sh', '-c', script], { env, timeoutMs, cwd: this.workdir });
  }

  private serialised<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  rebase(): Promise<PodRebase> {
    return this.serialised(async () => {
      const git = (script: string): Promise<PodExecResult> => this.sh(`${GIT}\nset -eu\ncd "$W"\n${script}`, { W: this.workdir });
      const fetched = await git('g fetch -q origin "+refs/heads/$HARMONIC_BASE:refs/remotes/origin/$HARMONIC_BASE"\ngit rev-parse "refs/remotes/origin/$HARMONIC_BASE"');
      if (fetched.code !== 0) return { ok: false, conflict: false, detail: (fetched.stderr || fetched.stdout).trim(), baseSha: null, conflictedFiles: [] };
      const baseSha = fetched.stdout.trim().split('\n').at(-1)!;
      const rebased = await git(`git -c user.name=Harmonic -c user.email=harmonic@localhost rebase --autostash ${baseSha}`);
      if (rebased.code === 0) return { ok: true, baseSha };
      const detail = (rebased.stderr || rebased.stdout).trim();
      const unmerged = await git('git diff --name-only --diff-filter=U');
      const conflictedFiles = unmerged.stdout.split('\n').filter((line) => line !== '');
      await git('git rebase --abort || true');
      return { ok: false, conflict: conflictedFiles.length > 0, detail, baseSha, conflictedFiles };
    });
  }

  checkpoint(): Promise<Checkpoint> {
    return this.serialised(async () => {
      const { branch } = this.spec;
      const pushed = await this.sh(
        `${GIT}
set -eu
cd "$W"
sha=$(git rev-parse HEAD)
forced=0
if [ -n "$HARMONIC_TIP" ] && ! git merge-base --is-ancestor "$HARMONIC_TIP" HEAD 2>/dev/null; then forced=1; fi
g push -q --force origin "HEAD:refs/heads/$HARMONIC_BRANCH"
echo "$sha $forced"`,
        { W: this.workdir, HARMONIC_TIP: this.remoteTip ?? '' },
      );
      if (pushed.code !== 0) return { branch, sha: null, forced: false, unchanged: false, error: (pushed.stderr || pushed.stdout).trim() || (pushed.timedOut ? 'timed out' : 'the push failed') };
      const [sha, forced] = pushed.stdout.trim().split('\n').at(-1)!.split(' ');
      const unchanged = sha === this.remoteTip;
      this.remoteTip = sha ?? null;
      return { branch, sha: sha ?? null, forced: forced === '1', unchanged };
    });
  }

  /** Deletes the pod and its Secret; safe to call more than once and after a failed start. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const { namespace } = this.spec.target;
    const failures: string[] = [];
    if (this.created) await this.api.deletePod(namespace, this.name).catch((error: unknown) => failures.push(`pod: ${errorMessage(error)}`));
    if (this.secretCreated) await this.api.deleteSecret(namespace, this.secretName).catch((error: unknown) => failures.push(`secret: ${errorMessage(error)}`));
    if (failures.length > 0) logger.warn(`task ${this.spec.taskId}: deleting ${this.name} failed (${failures.join('; ')})`);
    if (this.created || this.secretCreated) await this.record({ podState: failures.length > 0 ? 'lost' : 'deleted' });
  }
}
