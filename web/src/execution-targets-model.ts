import type {
  ConnectionTestRequest,
  CredentialHarness,
  TargetCredential,
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
  runningLabel: string;
  runningPercent: number;
  full: boolean;
  toggleLabel: 'Enable' | 'Disable' | null;
}

export function rowView(target: ExecutionTarget, hostCeiling = 0): RowView {
  const limit = target.builtIn ? hostCeiling : (target.concurrencyLimit ?? 0);
  return {
    name: target.name,
    builtIn: target.builtIn,
    statusLabel: target.builtIn ? 'built in' : target.enabled ? 'enabled' : 'disabled',
    runningLabel: `${target.running}/${limit} running`,
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

export interface RotateKeyCopy {
  running: TextPart[];
  newPods: string;
  proxy: { bold: string; rest: string };
  shownOnce: string;
}

export function rotateKeyCopy(name: string, running: number): RotateKeyCopy {
  const tickets = `${running} ${running === 1 ? 'Ticket is' : 'Tickets are'}`;
  return {
    running:
      running > 0
        ? [{ text: `${tickets} running on ` }, { text: name, code: true }, { text: ' now. Their next checkpoint push fails until they start a new pod.' }]
        : [{ text: 'No Tickets are running on ' }, { text: name, code: true }, { text: ' now, so no running pod loses git access.' }],
    newPods: 'New pods get a pass signed with the new key at start, so waiting Tickets are not affected.',
    proxy: {
      bold: 'Update the key on the Repository Proxy too.',
      rest: 'Until you do, the proxy rejects every pass from Harmonic, new ones included.',
    },
    shownOnce: 'The new key is shown once, for you to copy to the proxy. Harmonic stores it as a Secret and never shows it again.',
  };
}

export function rotatedSummary(revokedRunning: number): string {
  return `Rotated just now · ${revokedRunning} ${revokedRunning === 1 ? 'pass' : 'passes'} revoked.`;
}

export function proxyCheckPanel(outcome: 'agrees' | 'rejected' | 'unreachable'): { tone: 'ok' | 'fail'; title: string; body: string } {
  switch (outcome) {
    case 'agrees':
      return { tone: 'ok', title: 'Repository Proxy accepts Harmonic’s passes.', body: 'The proxy and Harmonic share the same key.' };
    case 'rejected':
      return { tone: 'fail', title: 'Repository Proxy rejected the last pass.', body: 'The proxy is likely still on the old key. Update it, then Test connection.' };
    case 'unreachable':
      return { tone: 'fail', title: 'Repository Proxy unreachable.', body: 'Check the Repository Proxy URL and that Harmonic can reach it.' };
  }
}

export function daysAgo(at: number, now: number): string {
  const days = Math.floor((now - at) / 86_400_000);
  if (days <= 0) return 'today';
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
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

export const CLAUDE_TOKEN_COMMAND = 'claude setup-token';

const HARNESS_LABELS: Record<CredentialHarness, string> = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot', opencode: 'OpenCode' };

export interface CredentialRowView {
  harness: CredentialHarness;
  label: string;
  set: boolean;
  pillLabel: 'set' | 'not set';
  pillTone: 'set' | 'unset' | 'optional';
  kindLabel: string;
  secretName: string | null;
  rotated: string | null;
  note: string | null;
  replaceLabel: string;
  canClear: boolean;
}

export function credentialRowView(credential: TargetCredential): CredentialRowView {
  const label = HARNESS_LABELS[credential.harness];
  const subscription = credential.kind === 'oauth-token';
  const kindLabel = credential.harness === 'claude' && subscription ? 'Claude subscription · OAuth token' : subscription ? 'OAuth token' : 'API key';
  const note = credential.set
    ? null
    : credential.harnessConfigured
      ? `No Secret yet. Steps that use ${label} on this target will escalate.`
      : 'Not configured as a Harness in this Harmonic, so nothing needs it.';
  return {
    harness: credential.harness,
    label,
    set: credential.set,
    pillLabel: credential.set ? 'set' : 'not set',
    pillTone: credential.set ? 'set' : credential.harnessConfigured ? 'unset' : 'optional',
    kindLabel,
    secretName: credential.set ? credential.secretName : null,
    rotated: credential.set && credential.updatedAt ? `last rotated ${formatShortDate(credential.updatedAt)}` : null,
    note,
    replaceLabel: credential.set ? 'Replace…' : subscription ? 'Add token…' : 'Add API key…',
    canClear: credential.set,
  };
}

export function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export interface CredentialPanelCopy {
  title: string;
  fieldLabel: string;
  stored: TextPart[];
  help: { label: string; intro: string; command: string | null; footnote: string };
}

export function credentialPanelCopy(credential: TargetCredential): CredentialPanelCopy {
  const label = HARNESS_LABELS[credential.harness];
  const claude = credential.harness === 'claude' && credential.kind === 'oauth-token';
  const noun = claude ? 'token' : 'API key';
  return {
    title: credential.set ? `Replace the ${label} ${noun}` : `Add the ${label} ${noun}`,
    fieldLabel: claude ? 'New Claude subscription token' : `New ${label} API key`,
    stored: [
      { text: 'Stored as the Secret ' },
      { text: credential.secretName, code: true },
      { text: `. Existing pods keep the old ${noun} until they end.` },
    ],
    help: {
      label: `How to get a ${noun}`,
      intro: claude
        ? 'A Claude subscription works in a pod through a long-lived OAuth token. Run this on a machine where you are signed in:'
        : `Create an API key for ${label} with its provider and paste it here.`,
      command: claude ? CLAUDE_TOKEN_COMMAND : null,
      footnote: 'Other Harnesses use an API key instead. Do not bake either into the image; Harmonic refuses images that contain credentials.',
    },
  };
}
