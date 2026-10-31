import type { TaskExecution } from '../db/schema.js';
import { DomainError } from '../domain/errors.js';
import type { RepositoryPassService } from '../repository-proxy/pass-service.js';
import type { ExecutionTargetService } from './execution-targets.js';
import { Git } from './git.js';
import type { PodApiFactory } from './kubernetes-pods.js';
import { PodSession } from './pod-session.js';

export interface PodRequest {
  runsOn: string;
  image: string | undefined;
  source: TaskExecution['source'];
}

export interface PodOpenerSubject {
  id?: number;
  workingDir: string;
}

export interface PodOpener<S> {
  open(task: S, request: PodRequest): Promise<PodSession>;
}

export interface PodOpenerDeps<S extends PodOpenerSubject> {
  targets: Pick<ExecutionTargetService, 'podAccess'>;
  passes: Pick<RepositoryPassService, 'issue'>;
  apiFactory: PodApiFactory;
  baseBranchFor: (task: S) => Promise<string>;
  setExecution: (task: S, execution: TaskExecution) => Promise<void>;
  workdir?: string;
}

const withoutCredentials = (url: string): string => {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
};

export function createPodOpener<S extends PodOpenerSubject>(deps: PodOpenerDeps<S>): PodOpener<S> {
  return {
    async open(task, request) {
      if (task.id === undefined) throw new DomainError('invalid_state', 'only a Task runs in a pod');
      const taskId = task.id;
      const { target, access } = await deps.targets.podAccess(request.runsOn);
      const origin = await Git.originUrl(task.workingDir);
      if (origin === null) throw new DomainError('invalid_state', `Execution Target '${target.name}' needs a Code Repository, and ${task.workingDir} has no origin remote`);
      const session = new PodSession(
        { taskId, target, image: request.image ?? target.defaultImage, source: request.source, codeRepository: withoutCredentials(origin), baseBranch: await deps.baseBranchFor(task), branch: `harmonic/task-${taskId}` },
        { api: deps.apiFactory(access), passes: deps.passes, onExecution: (execution) => deps.setExecution(task, execution), ...(deps.workdir === undefined ? {} : { workdir: deps.workdir }) },
      );
      await session.start();
      return session;
    },
  };
}
