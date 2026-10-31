import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AsyncDbHandle } from '../db/async.js';
import { isUniqueViolation } from '../db/errors.js';
import { EXECUTION_TARGET_AUTH_METHODS, executionTargets, type ExecutionTargetRow } from '../db/schema.js';
import { DomainError } from '../domain/errors.js';
import type { WorkspaceService } from '../domain/workspaces.js';
import { forEachYielding } from '../reliability/yield.js';
import { RepositoryPassService, signingKeySecretName, type ProxyKeyCheck } from '../repository-proxy/pass-service.js';
import type { GlobalSecretService } from '../secrets/global-secret-service.js';
import {
  CONNECTION_TEST_TIMEOUT_MS,
  classifyConnectionError,
  defaultKubernetesClientFactory,
  withTimeout,
  type ConnectionOutcome,
  type KubernetesClientFactory,
} from './kubernetes-client.js';

export const LOCAL_TARGET = 'local';
export const MAX_KUBECONFIG_BYTES = 262_144;

export const executionTargetNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,48}$/, 'a target name is 1-48 letters, digits, `_`, `.` or `-`')
  .refine((name) => name.toLowerCase() !== LOCAL_TARGET, '`local` is built in and cannot be used as a target name');

const requiredText = (max: number) => z.string().trim().min(1).max(max);

const proxyUrlSchema = z
  .string()
  .trim()
  .refine((value) => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'the Repository Proxy URL must be an http:// or https:// URL');

export const kubeconfigSchema = z.string().min(1).max(MAX_KUBECONFIG_BYTES);

export const executionTargetFieldsSchema = z.object({
  enabled: z.boolean().meta({ example: true }),
  authMethod: z.enum(EXECUTION_TARGET_AUTH_METHODS).meta({ example: 'kubeconfig' }),
  namespace: requiredText(253).meta({ example: 'harmonic-agents' }),
  defaultImage: requiredText(512).meta({ example: 'ghcr.io/mintopia/harmonic-harnesses:2.19.0' }),
  cpu: requiredText(32).meta({ example: '2' }),
  memory: requiredText(32).meta({ example: '4Gi' }),
  concurrencyLimit: z.number().int().min(1).meta({ example: 4 }),
  repositoryProxyUrl: proxyUrlSchema.meta({ example: 'https://repo-proxy.harmonic-agents.svc.cluster.local' }),
});

export const createExecutionTargetSchema = executionTargetFieldsSchema.extend({
  name: executionTargetNameSchema.meta({ example: 'k8s-prod' }),
  enabled: executionTargetFieldsSchema.shape.enabled.default(true),
});
export type CreateExecutionTargetInput = z.infer<typeof createExecutionTargetSchema>;

export const updateExecutionTargetSchema = executionTargetFieldsSchema.partial().extend({ name: executionTargetNameSchema.optional() });
export type UpdateExecutionTargetInput = z.infer<typeof updateExecutionTargetSchema>;

export interface KubeconfigStatus {
  set: boolean;
  secretName: string | null;
  updatedAt: number | null;
}

export interface ProxyKeyStatus {
  set: boolean;
  secretName: string;
  rotatedAt: number | null;
}

export interface ProxyKeyRotation {
  key: string;
  rotatedAt: number;
  revokedRunning: number;
}

export interface ExecutionTargetView {
  name: string;
  builtIn: boolean;
  enabled: boolean;
  authMethod: 'kubeconfig' | 'in-cluster' | null;
  namespace: string | null;
  defaultImage: string | null;
  cpu: string | null;
  memory: string | null;
  concurrencyLimit: number | null;
  repositoryProxyUrl: string | null;
  kubeconfig: KubeconfigStatus | null;
  proxyKey: ProxyKeyStatus | null;
  running: number;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface ConnectionTestResult {
  ok: boolean;
  outcome: ConnectionOutcome;
  message: string;
  podCount?: number;
  namespace: string;
  secretName: string | null;
}

export interface ConnectionTestDraft {
  name?: string | undefined;
  authMethod: 'kubeconfig' | 'in-cluster';
  namespace: string;
  kubeconfig?: string | undefined;
}

export interface DeletionImpact {
  running: number;
  waiting: number;
  total: number;
}

export const LOCAL_TARGET_VIEW: ExecutionTargetView = {
  name: LOCAL_TARGET,
  builtIn: true,
  enabled: true,
  authMethod: null,
  namespace: null,
  defaultImage: null,
  cpu: null,
  memory: null,
  concurrencyLimit: null,
  repositoryProxyUrl: null,
  kubeconfig: null,
  proxyKey: null,
  running: 0,
  createdAt: null,
  updatedAt: null,
};

export const kubeconfigSecretName = (target: string): string => `${target}-kubeconfig`;

export interface ExecutionTargetServiceDeps {
  db: AsyncDbHandle;
  secrets: GlobalSecretService;
  workspaces: Pick<WorkspaceService, 'list' | 'update'>;
  clientFactory?: KubernetesClientFactory;
  testTimeoutMs?: number;
}

export class ExecutionTargetService {
  private readonly db: AsyncDbHandle;
  private readonly secrets: GlobalSecretService;
  private readonly workspaces: Pick<WorkspaceService, 'list' | 'update'>;
  private readonly clientFactory: KubernetesClientFactory;
  private readonly testTimeoutMs: number;
  private readonly passes: RepositoryPassService;

  constructor(deps: ExecutionTargetServiceDeps) {
    this.db = deps.db;
    this.secrets = deps.secrets;
    this.workspaces = deps.workspaces;
    this.clientFactory = deps.clientFactory ?? defaultKubernetesClientFactory;
    this.testTimeoutMs = deps.testTimeoutMs ?? CONNECTION_TEST_TIMEOUT_MS;
    this.passes = new RepositoryPassService(deps.secrets);
  }

  private async view(row: ExecutionTargetRow): Promise<ExecutionTargetView> {
    const status = row.kubeconfigSecret ? await this.secrets.status(row.kubeconfigSecret) : null;
    const keyName = signingKeySecretName(row.name);
    const key = await this.secrets.status(keyName);
    return {
      name: row.name,
      builtIn: false,
      enabled: row.enabled,
      authMethod: row.authMethod,
      namespace: row.namespace,
      defaultImage: row.defaultImage,
      cpu: row.cpu,
      memory: row.memory,
      concurrencyLimit: row.concurrencyLimit,
      repositoryProxyUrl: row.repositoryProxyUrl,
      kubeconfig: { set: status !== null, secretName: row.kubeconfigSecret, updatedAt: status?.updatedAt ?? null },
      proxyKey: { set: key !== null, secretName: keyName, rotatedAt: key?.updatedAt ?? null },
      running: await this.runningCount(row.name),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ponytail: always 0 until `runs_on` ties Tickets to targets.
  private async runningCount(_name: string): Promise<number> {
    return 0;
  }

  private async row(name: string): Promise<ExecutionTargetRow> {
    if (name === LOCAL_TARGET) throw new DomainError('conflict', "'local' is built in and cannot be changed");
    const row = await this.db.read((db) => db.select().from(executionTargets).where(eq(executionTargets.name, name)).get());
    if (!row) throw new DomainError('not_found', `execution target '${name}' not found`);
    return row;
  }

  async list(): Promise<ExecutionTargetView[]> {
    const rows = await this.db.read((db) => db.select().from(executionTargets).orderBy(executionTargets.createdAt, executionTargets.id).all());
    return Promise.all(rows.map((row) => this.view(row)));
  }

  async listWithLocal(): Promise<ExecutionTargetView[]> {
    return [LOCAL_TARGET_VIEW, ...(await this.list())];
  }

  async get(name: string): Promise<ExecutionTargetView> {
    if (name === LOCAL_TARGET) return LOCAL_TARGET_VIEW;
    return this.view(await this.row(name));
  }

  async find(name: string): Promise<ExecutionTargetView | null> {
    if (name === LOCAL_TARGET) return null;
    const row = await this.db.read((db) => db.select().from(executionTargets).where(eq(executionTargets.name, name)).get());
    return row ? this.view(row) : null;
  }

  async create(input: CreateExecutionTargetInput): Promise<ExecutionTargetView> {
    const now = Date.now();
    try {
      const row = await this.db.write((db) =>
        db.insert(executionTargets).values({ ...input, kubeconfigSecret: null, createdAt: now, updatedAt: now }).returning().get(),
      );
      return this.view(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new DomainError('conflict', `an execution target named '${input.name}' already exists`);
      throw err;
    }
  }

  async update(name: string, patch: UpdateExecutionTargetInput): Promise<ExecutionTargetView> {
    const current = await this.row(name);
    const newName = patch.name ?? current.name;
    const authMethod = patch.authMethod ?? current.authMethod;
    let kubeconfigSecret = current.kubeconfigSecret;

    if (authMethod === 'in-cluster' && kubeconfigSecret) {
      await this.secrets.clear(kubeconfigSecret);
      kubeconfigSecret = null;
    } else if (kubeconfigSecret && newName !== current.name) {
      const value = await this.secrets.reveal(kubeconfigSecret);
      const renamed = kubeconfigSecretName(newName);
      if (value !== null) await this.secrets.set(renamed, value);
      await this.secrets.clear(kubeconfigSecret);
      kubeconfigSecret = value !== null ? renamed : null;
    }

    if (newName !== current.name) {
      const oldKey = signingKeySecretName(current.name);
      const proxyKey = await this.secrets.reveal(oldKey);
      if (proxyKey !== null) {
        await this.secrets.set(signingKeySecretName(newName), proxyKey);
        await this.secrets.clear(oldKey);
      }
    }

    const { name: _name, ...fields } = patch;
    try {
      const row = await this.db.write((db) =>
        db
          .update(executionTargets)
          .set({ ...fields, name: newName, authMethod, kubeconfigSecret, updatedAt: Date.now() })
          .where(eq(executionTargets.id, current.id))
          .returning()
          .get(),
      );
      if (newName !== current.name) await this.rewriteWorkspaceLists(current.name, newName);
      return this.view(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new DomainError('conflict', `an execution target named '${newName}' already exists`);
      throw err;
    }
  }

  async setKubeconfig(name: string, kubeconfig: string): Promise<KubeconfigStatus> {
    const current = await this.row(name);
    if (current.authMethod !== 'kubeconfig') throw new DomainError('conflict', `execution target '${name}' uses the in-cluster service account, not a kubeconfig`);
    const secretName = kubeconfigSecretName(current.name);
    const status = await this.secrets.set(secretName, kubeconfig);
    await this.db.write((db) => db.update(executionTargets).set({ kubeconfigSecret: secretName, updatedAt: Date.now() }).where(eq(executionTargets.id, current.id)).run());
    return { set: true, secretName, updatedAt: status.updatedAt };
  }

  async clearKubeconfig(name: string): Promise<KubeconfigStatus> {
    const current = await this.row(name);
    if (current.kubeconfigSecret) await this.secrets.clear(current.kubeconfigSecret);
    await this.db.write((db) => db.update(executionTargets).set({ kubeconfigSecret: null, updatedAt: Date.now() }).where(eq(executionTargets.id, current.id)).run());
    return { set: false, secretName: null, updatedAt: null };
  }

  async rotateProxyKey(name: string): Promise<ProxyKeyRotation> {
    const current = await this.row(name);
    const rotated = await this.passes.rotate(current.name);
    return { ...rotated, revokedRunning: await this.runningCount(current.name) };
  }

  async checkProxyKey(name: string): Promise<ProxyKeyCheck> {
    const current = await this.row(name);
    return this.passes.checkProxy(current.name, current.repositoryProxyUrl);
  }

  // ponytail: escalates nothing until `runs_on` ties Tickets to targets.
  async deletionImpact(name: string): Promise<DeletionImpact> {
    await this.row(name);
    return { running: 0, waiting: 0, total: 0 };
  }

  async delete(name: string): Promise<DeletionImpact> {
    const current = await this.row(name);
    const impact = await this.deletionImpact(name);
    await this.db.write((db) => db.delete(executionTargets).where(eq(executionTargets.id, current.id)).run());
    if (current.kubeconfigSecret) await this.secrets.clear(current.kubeconfigSecret);
    await this.secrets.clear(signingKeySecretName(name));
    await this.rewriteWorkspaceLists(name, null);
    return impact;
  }

  private async rewriteWorkspaceLists(from: string, to: string | null): Promise<void> {
    await forEachYielding(await this.workspaces.list(), async (workspace) => {
      const list = workspace.executionTargets;
      if (!list?.includes(from)) return;
      const next = [...new Set(list.map((entry) => (entry === from ? to : entry)).filter((entry): entry is string => entry !== null))];
      await this.workspaces.update(workspace.id, { executionTargets: next });
    });
  }

  async testConnection(name: string): Promise<ConnectionTestResult> {
    const row = await this.row(name);
    return this.runTest({ authMethod: row.authMethod, namespace: row.namespace, secretName: row.kubeconfigSecret, kubeconfig: undefined });
  }

  /** A missing `kubeconfig` falls back to the stored Secret. */
  async testDraft(draft: ConnectionTestDraft): Promise<ConnectionTestResult> {
    const stored = draft.name ? await this.find(draft.name) : null;
    const secretName = draft.kubeconfig === undefined ? (stored?.kubeconfig?.secretName ?? null) : null;
    return this.runTest({ authMethod: draft.authMethod, namespace: draft.namespace, secretName, kubeconfig: draft.kubeconfig });
  }

  private async runTest(input: { authMethod: 'kubeconfig' | 'in-cluster'; namespace: string; secretName: string | null; kubeconfig: string | undefined }): Promise<ConnectionTestResult> {
    const { namespace } = input;
    const secretName = input.authMethod === 'kubeconfig' ? input.secretName : null;
    const fail = (outcome: Exclude<ConnectionOutcome, 'connected'>, detail: string): ConnectionTestResult => ({
      ok: false,
      outcome,
      message: failureMessage(outcome, namespace, detail),
      namespace,
      secretName,
    });
    try {
      let kubeconfig: string | null = null;
      if (input.authMethod === 'kubeconfig') {
        kubeconfig = input.kubeconfig ?? (secretName ? await this.secrets.reveal(secretName) : null);
        if (kubeconfig === null) return fail('invalid-kubeconfig', 'no kubeconfig is set for this target');
      }
      const client = this.clientFactory({ authMethod: input.authMethod, kubeconfig });
      const result = await withTimeout(
        (async () => {
          const podCount = await client.countPods(namespace);
          const exists = podCount === 0 ? await client.namespaceExists(namespace) : true;
          return { podCount, exists };
        })(),
        this.testTimeoutMs,
      );
      if (result.exists === false) return fail('namespace-not-found', '');
      return {
        ok: true,
        outcome: 'connected',
        message: `Connected: listed namespace ${namespace} (${result.podCount} ${result.podCount === 1 ? 'pod' : 'pods'})`,
        podCount: result.podCount,
        namespace,
        secretName,
      };
    } catch (err) {
      if (err instanceof DomainError) return fail('invalid-kubeconfig', err.message);
      const { outcome, detail } = classifyConnectionError(err);
      return fail(outcome, detail);
    }
  }
}

function failureMessage(outcome: Exclude<ConnectionOutcome, 'connected'>, namespace: string, detail: string): string {
  switch (outcome) {
    case 'unauthorized':
      return `Unauthorized: the cluster rejected the credentials (${detail}). Use a kubeconfig whose user can list pods in namespace ${namespace}.`;
    case 'namespace-not-found':
      return `Namespace not found: ${namespace} does not exist on this cluster.`;
    case 'unreachable':
      return `Cluster unreachable (${detail}). Check the server address in the kubeconfig and that Harmonic can reach it.`;
    case 'invalid-kubeconfig':
      return `Invalid kubeconfig: ${detail}.`;
  }
}
