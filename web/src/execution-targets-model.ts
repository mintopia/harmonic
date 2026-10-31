import type {
  ConnectionTestRequest,
  ConnectionTestResult,
  DeletionImpact,
  ExecutionTarget,
  ExecutionTargetBody,
  WorkspaceTargetItem,
} from './types.js';

export const LOCAL_TARGET = 'local';

export interface TargetDraft {
  name: string;
  enabled: boolean;
  authMethod: 'kubeconfig' | 'in-cluster';
  namespace: string;
  defaultImage: string;
  cpu: string;
  memory: string;
  concurrencyLimit: string;
  repositoryProxyUrl: string;
  kubeconfig: string;
}

export const NEW_TARGET_DRAFT: TargetDraft = {
  name: '',
  enabled: false,
  authMethod: 'kubeconfig',
  namespace: 'harmonic-agents',
  defaultImage: '',
  cpu: '2',
  memory: '4Gi',
  concurrencyLimit: '4',
  repositoryProxyUrl: '',
  kubeconfig: '',
};

export function draftFromTarget(target: ExecutionTarget): TargetDraft {
  return {
    name: target.name,
    enabled: target.enabled,
    authMethod: target.authMethod ?? 'kubeconfig',
    namespace: target.namespace ?? '',
    defaultImage: target.defaultImage ?? '',
    cpu: target.cpu ?? '',
    memory: target.memory ?? '',
    concurrencyLimit: String(target.concurrencyLimit ?? ''),
    repositoryProxyUrl: target.repositoryProxyUrl ?? '',
    kubeconfig: '',
  };
}

export function draftBody(draft: TargetDraft): ExecutionTargetBody {
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    authMethod: draft.authMethod,
    namespace: draft.namespace.trim(),
    defaultImage: draft.defaultImage.trim(),
    cpu: draft.cpu.trim(),
    memory: draft.memory.trim(),
    concurrencyLimit: Number(draft.concurrencyLimit.trim()),
    repositoryProxyUrl: draft.repositoryProxyUrl.trim(),
  };
}

export function draftPatch(draft: TargetDraft, saved: ExecutionTarget): Partial<ExecutionTargetBody> {
  const next = draftBody(draft);
  const before = draftBody(draftFromTarget(saved));
  const patch: Partial<ExecutionTargetBody> = {};
  for (const key of Object.keys(next) as (keyof ExecutionTargetBody)[]) {
    if (next[key] !== before[key]) Object.assign(patch, { [key]: next[key] });
  }
  return patch;
}

const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,48}$/;

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export type DraftField = 'name' | 'namespace' | 'defaultImage' | 'cpu' | 'memory' | 'concurrencyLimit' | 'repositoryProxyUrl';

export function draftErrors(draft: TargetDraft): Partial<Record<DraftField, string>> {
  const errors: Partial<Record<DraftField, string>> = {};
  const name = draft.name.trim();
  if (!NAME_PATTERN.test(name)) errors.name = 'A target name is 1-48 letters, digits, _, . or -.';
  else if (name.toLowerCase() === LOCAL_TARGET) errors.name = '`local` is built in and cannot be used as a target name.';
  if (!draft.namespace.trim()) errors.namespace = 'Enter the namespace pods run in.';
  if (!draft.defaultImage.trim()) errors.defaultImage = 'Enter a default pod image.';
  if (!draft.cpu.trim()) errors.cpu = 'Enter a CPU amount.';
  if (!draft.memory.trim()) errors.memory = 'Enter a memory amount.';
  const limit = Number(draft.concurrencyLimit.trim());
  if (!Number.isInteger(limit) || limit < 1) errors.concurrencyLimit = 'Enter a whole number of at least 1.';
  if (!isHttpUrl(draft.repositoryProxyUrl.trim())) errors.repositoryProxyUrl = 'The Repository Proxy URL must be an http:// or https:// URL.';
  return errors;
}

export const hasDraftErrors = (draft: TargetDraft): boolean => Object.keys(draftErrors(draft)).length > 0;

export function connectionTestRequest(draft: TargetDraft, saved: ExecutionTarget | null): ConnectionTestRequest {
  const request: ConnectionTestRequest = { authMethod: draft.authMethod, namespace: draft.namespace.trim() };
  if (saved) request.name = saved.name;
  if (draft.authMethod === 'kubeconfig' && draft.kubeconfig.trim()) request.kubeconfig = draft.kubeconfig;
  return request;
}

export function canTestConnection(draft: TargetDraft, saved: ExecutionTarget | null): boolean {
  if (!draft.namespace.trim()) return false;
  if (draft.authMethod === 'in-cluster') return true;
  return draft.kubeconfig.trim() !== '' || (saved?.kubeconfig?.set ?? false);
}

export interface TextPart {
  text: string;
  code?: boolean;
}

const t = (text: string): TextPart => ({ text });
const c = (text: string): TextPart => ({ text, code: true });

export interface ResultPanel {
  tone: 'ok' | 'bad';
  title: string;
  body: TextPart[];
  why: TextPart[];
}

export function testingMessage(namespace: string): TextPart[] {
  return [t('Connecting to the cluster and listing namespace '), c(namespace), t('…')];
}

const podCountText = (count: number) => `${count} ${count === 1 ? 'pod' : 'pods'}`;

export function resultPanel(result: ConnectionTestResult): ResultPanel {
  const secret = result.secretName;
  const access = secret ? ([t('the kubeconfig Secret '), c(secret)] as TextPart[]) : [t('the service account')];
  switch (result.outcome) {
    case 'connected':
      return {
        tone: 'ok',
        title: 'Connected:',
        body: [
          t('listed namespace '),
          c(result.namespace),
          t(result.podCount === undefined ? '' : ` (${podCountText(result.podCount)})`),
        ],
        why: secret ? [t('Checked just now with Secret '), c(secret), t('.')] : [t('Checked just now with the in-cluster service account.')],
      };
    case 'unauthorized':
      return {
        tone: 'bad',
        title: 'Unauthorized:',
        body: [...access, t(' was rejected by the cluster.')],
        why: [
          t(
            secret
              ? 'Replace the Secret with a kubeconfig whose user can list pods in this namespace.'
              : 'Grant the service account permission to list pods in this namespace.',
          ),
        ],
      };
    case 'namespace-not-found':
      return {
        tone: 'bad',
        title: 'Namespace not found:',
        body: [c(result.namespace), t(' does not exist on this cluster.')],
        why: [t('Create the namespace, or correct the name above.')],
      };
    case 'unreachable':
      return {
        tone: 'bad',
        title: 'Cluster unreachable:',
        body: [t(result.message)],
        why: [t('Check the server address in the kubeconfig and that Harmonic can reach it.')],
      };
    case 'invalid-kubeconfig':
      return {
        tone: 'bad',
        title: 'Invalid kubeconfig:',
        body: [t(result.message.replace(/^invalid kubeconfig:\s*/i, ''))],
        why: [t('Replace the kubeconfig with a valid one.')],
      };
  }
}

export interface RowView {
  name: string;
  builtIn: boolean;
  statusLabel: 'built in' | 'enabled' | 'disabled';
  runningLabel: string | null;
  runningPercent: number;
  full: boolean;
  toggleLabel: 'Enable' | 'Disable' | null;
}

export function rowView(target: ExecutionTarget): RowView {
  const limit = target.concurrencyLimit ?? 0;
  return {
    name: target.name,
    builtIn: target.builtIn,
    statusLabel: target.builtIn ? 'built in' : target.enabled ? 'enabled' : 'disabled',
    runningLabel: target.builtIn ? null : `${target.running}/${limit} running`,
    runningPercent: limit > 0 ? Math.min(100, Math.round((target.running / limit) * 100)) : 0,
    full: limit > 0 && target.running >= limit,
    toggleLabel: target.builtIn ? null : target.enabled ? 'Disable' : 'Enable',
  };
}

export interface DeleteCopy {
  title: string;
  confirmLabel: string;
  banner: { headline: string; detail: string } | null;
}

const countVerb = (n: number) => (n === 1 ? 'is' : 'are');

export function deleteCopy(name: string, impact: DeletionImpact | null): DeleteCopy {
  const parts: string[] = [];
  if (impact && impact.running > 0) parts.push(`${impact.running} ${countVerb(impact.running)} running there`);
  if (impact && impact.waiting > 0) parts.push(`${impact.waiting} ${countVerb(impact.waiting)} waiting for it`);
  const banner =
    impact && impact.total > 0
      ? {
          headline: `${impact.total} ${impact.total === 1 ? 'Ticket' : 'Tickets'} will escalate.`,
          detail: `${parts.join(' and ')}. ${impact.total === 1 ? 'It escalates' : 'Each escalates'} with “Execution Target ‘${name}’ was deleted”.`,
        }
      : null;
  return {
    title: 'Delete Execution Target',
    confirmLabel: `Delete ${name}`,
    banner,
  };
}

export interface WorkspaceRefusal {
  parts: TextPart[];
  link: string | null;
}

export interface WorkspaceRowView {
  name: string;
  builtIn: boolean;
  on: boolean;
  note: TextPart[];
  refusal: WorkspaceRefusal | null;
}

export function workspaceRefusal(name: string, codeRepository: string | null): WorkspaceRefusal {
  if (codeRepository === null) {
    return {
      parts: [c(name), t(" needs a Code Repository: the remote is the base branch's source of truth.")],
      link: 'Add one in Workspace settings.',
    };
  }
  return {
    parts: [
      t('Kubernetes targets are not available to a Workspace in '),
      c('direct'),
      t(' mode. Switch the Isolation Mode to '),
      c('worktree'),
      t(' first.'),
    ],
    link: null,
  };
}

export function isTargetOn(override: string[] | null, item: Pick<WorkspaceTargetItem, 'name' | 'builtIn' | 'globallyEnabled'>): boolean {
  if (item.builtIn) return true;
  return override === null ? item.globallyEnabled : override.includes(item.name);
}

export function toggleTarget(override: string[] | null, items: WorkspaceTargetItem[], name: string, on: boolean): string[] | null {
  const kubernetes = items.filter((item) => !item.builtIn);
  const current = new Set(override ?? kubernetes.filter((item) => item.globallyEnabled).map((item) => item.name));
  if (on) current.add(name);
  else current.delete(name);
  const next = kubernetes.map((item) => item.name).filter((n) => current.has(n));
  const inherited = kubernetes.filter((item) => item.globallyEnabled).map((item) => item.name);
  const sameAsInherited = next.length === inherited.length && inherited.every((n) => current.has(n));
  return sameAsInherited ? null : next;
}

export function workspaceRows(items: WorkspaceTargetItem[], override: string[] | null, codeRepository: string | null, isolationMode: string): WorkspaceRowView[] {
  return items.map((item) => {
    const on = isTargetOn(override, item);
    const explicitOn = on && override !== null && !item.builtIn;
    const note = item.builtIn
      ? [t('Always on')]
      : !item.globallyEnabled
        ? [t('Disabled globally. Turning it on here has no effect until it is enabled.')]
        : [t('Code Repository '), c(codeRepository ?? 'none'), t(' · Isolation Mode '), c(isolationMode)];
    return { name: item.name, builtIn: item.builtIn, on, note, refusal: explicitOn && item.refusal ? workspaceRefusal(item.name, codeRepository) : null };
  });
}
