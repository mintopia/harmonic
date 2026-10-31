import { describe, expect, it } from 'vitest';
import {
  NEW_TARGET_DRAFT,
  canTestConnection,
  connectionTestRequest,
  credentialPanelCopy,
  credentialRowView,
  daysAgo,
  deleteCopy,
  proxyCheckPanel,
  rotateKeyCopy,
  rotatedSummary,
  draftBody,
  draftErrors,
  draftFromTarget,
  draftPatch,
  workspaceRefusal,
  resultPanel,
  rowView,
  toggleTarget,
  workspaceRows,
} from '../web/src/execution-targets-model.js';
import type { TargetCredential, ConnectionTestResult, ExecutionTarget, WorkspaceTargetItem } from '../web/src/types.js';

const prod: ExecutionTarget = {
  name: 'k8s-prod',
  builtIn: false,
  enabled: true,
  authMethod: 'kubeconfig',
  namespace: 'harmonic-agents',
  defaultImage: 'ghcr.io/mintopia/harmonic-harnesses:2.19.0',
  cpu: '2',
  memory: '4Gi',
  concurrencyLimit: 4,
  repositoryProxyUrl: 'https://repo-proxy.example',
  kubeconfig: { set: true, secretName: 'k8s-prod-kubeconfig', updatedAt: 1 },
  proxyKey: { set: true, secretName: 'k8s-prod-proxy-key', rotatedAt: 1 },
  credentials: [],
  running: 2,
  waiting: 0,
  createdAt: 1,
  updatedAt: 1,
};

const item = (name: string, over: Partial<WorkspaceTargetItem> = {}): WorkspaceTargetItem => ({
  name,
  builtIn: false,
  globallyEnabled: true,
  allowed: true,
  effective: true,
  ineffectiveReason: null,
  refusal: null,
  ...over,
});
const items = [item('local', { builtIn: true }), item('k8s-prod'), item('k8s-staging', { globallyEnabled: false })];

describe('editor draft to request body', () => {
  it('parses the concurrency limit and trims text', () => {
    const body = draftBody({ ...draftFromTarget(prod), name: ' k8s-prod ', concurrencyLimit: ' 4 ' });
    expect(body).toMatchObject({ name: 'k8s-prod', concurrencyLimit: 4, authMethod: 'kubeconfig', cpu: '2', memory: '4Gi' });
  });

  it('sends only changed fields, including a rename', () => {
    expect(draftPatch(draftFromTarget(prod), prod)).toEqual({});
    expect(draftPatch({ ...draftFromTarget(prod), name: 'k8s-main', enabled: false, cpu: '4' }, prod)).toEqual({ name: 'k8s-main', enabled: false, cpu: '4' });
  });

  it('starts a new target disabled so it can be tested first', () => {
    expect(NEW_TARGET_DRAFT.enabled).toBe(false);
  });

  it('flags every invalid field', () => {
    const errors = draftErrors({ ...NEW_TARGET_DRAFT, name: 'Local', namespace: '', concurrencyLimit: '0', repositoryProxyUrl: 'ftp://x' });
    expect(Object.keys(errors).sort()).toEqual(['concurrencyLimit', 'defaultImage', 'name', 'namespace', 'repositoryProxyUrl']);
    expect(draftErrors(draftFromTarget(prod))).toEqual({});
  });
});

describe('test connection request', () => {
  it('names a saved target so the stored kubeconfig is used, and omits an empty paste', () => {
    expect(connectionTestRequest(draftFromTarget(prod), prod)).toEqual({ name: 'k8s-prod', authMethod: 'kubeconfig', namespace: 'harmonic-agents' });
  });

  it('sends a pasted kubeconfig and none for in-cluster', () => {
    const draft = { ...draftFromTarget(prod), kubeconfig: 'apiVersion: v1' };
    expect(connectionTestRequest(draft, null).kubeconfig).toBe('apiVersion: v1');
    expect(connectionTestRequest({ ...draft, authMethod: 'in-cluster' }, null).kubeconfig).toBeUndefined();
  });

  it('needs a kubeconfig, stored or pasted, before testing', () => {
    expect(canTestConnection(NEW_TARGET_DRAFT, null)).toBe(false);
    expect(canTestConnection({ ...NEW_TARGET_DRAFT, kubeconfig: 'x' }, null)).toBe(true);
    expect(canTestConnection(draftFromTarget(prod), prod)).toBe(true);
    expect(canTestConnection({ ...NEW_TARGET_DRAFT, authMethod: 'in-cluster' }, null)).toBe(true);
  });
});

describe('connection outcome panels', () => {
  const result = (over: Partial<ConnectionTestResult>): ConnectionTestResult => ({ ok: false, outcome: 'unreachable', message: 'timed out after 10 s', namespace: 'harmonic-agents', secretName: 'k8s-prod-kubeconfig', ...over });
  const text = (parts: { text: string }[]) => parts.map((p) => p.text).join('');

  it('reports a pod count on success', () => {
    const panel = resultPanel(result({ ok: true, outcome: 'connected', podCount: 6 }));
    expect(panel.tone).toBe('ok');
    expect(text(panel.body)).toBe('listed namespace harmonic-agents (6 pods)');
    expect(text(panel.why)).toBe('Checked just now with Secret k8s-prod-kubeconfig.');
  });

  it('names the rejected Secret on unauthorized', () => {
    const panel = resultPanel(result({ outcome: 'unauthorized' }));
    expect(panel.tone).toBe('bad');
    expect(text(panel.body)).toBe('the kubeconfig Secret k8s-prod-kubeconfig was rejected by the cluster.');
  });

  it('distinguishes namespace, network and kubeconfig failures', () => {
    expect(resultPanel(result({ outcome: 'namespace-not-found' })).title).toBe('Namespace not found:');
    expect(resultPanel(result({ outcome: 'unreachable' })).title).toBe('Cluster unreachable:');
    expect(resultPanel(result({ outcome: 'invalid-kubeconfig', message: 'bad yaml' })).title).toBe('Invalid kubeconfig:');
  });

  it('describes in-cluster access without a Secret', () => {
    expect(text(resultPanel(result({ outcome: 'unauthorized', secretName: null })).body)).toBe('the service account was rejected by the cluster.');
  });
});

describe('row view', () => {
  it('shows running over limit and flags a full target', () => {
    expect(rowView(prod)).toMatchObject({ statusLabel: 'enabled', runningLabel: '2/4 running', runningPercent: 50, full: false, toggleLabel: 'Disable' });
    expect(rowView({ ...prod, enabled: false, running: 4 })).toMatchObject({ statusLabel: 'disabled', full: true, toggleLabel: 'Enable' });
  });
});

describe('delete confirmation copy', () => {
  it('counts running and waiting Tickets', () => {
    const copy = deleteCopy('k8s-prod', { running: 2, waiting: 1, total: 3 });
    expect(copy.banner).toEqual({
      headline: '3 Tickets will escalate.',
      detail: '2 are running there and 1 is waiting for it. Each escalates with “Execution Target ‘k8s-prod’ was deleted”.',
    });
    expect(copy.confirmLabel).toBe('Delete k8s-prod');
  });

  it('uses singular wording and omits the banner when nothing is affected', () => {
    expect(deleteCopy('x', { running: 0, waiting: 1, total: 1 }).banner?.headline).toBe('1 Ticket will escalate.');
    expect(deleteCopy('x', { running: 0, waiting: 0, total: 0 }).banner).toBeNull();
    expect(deleteCopy('x', null).banner).toBeNull();
  });
});

const plain = (parts: { text: string }[]) => parts.map((p) => p.text).join('');

describe('Workspace allow list', () => {
  it('an inheriting Workspace shows enabled targets on and disabled ones off', () => {
    const rows = workspaceRows(items, null, 'mintopia/harmonic', 'worktree');
    expect(rows.map((r) => r.on)).toEqual([true, true, false]);
    expect(plain(rows[0]!.note)).toBe('Always on');
    expect(plain(rows[1]!.note)).toBe('Code Repository mintopia/harmonic · Isolation Mode worktree');
    expect(plain(rows[2]!.note)).toContain('Disabled globally');
  });

  it('turning one off from inherit lists the rest; turning back on collapses to inherit', () => {
    expect(toggleTarget(null, items, 'k8s-prod', false)).toEqual([]);
    expect(toggleTarget([], items, 'k8s-prod', true)).toBeNull();
  });

  it('turning on a globally disabled target makes an explicit list', () => {
    expect(toggleTarget(null, items, 'k8s-staging', true)).toEqual(['k8s-prod', 'k8s-staging']);
  });

  it('shows the refusal inline only for an explicitly allowed target', () => {
    const refused = [item('local', { builtIn: true }), item('k8s-prod', { refusal: 'refused' })];
    expect(workspaceRows(refused, null, null, 'worktree')[1]!.refusal).toBeNull();
    const row = workspaceRows(refused, ['k8s-prod'], null, 'worktree')[1]!;
    expect(row.refusal?.link).toBe('Add one in Workspace settings.');
    expect(plain(row.refusal!.parts)).toBe("k8s-prod needs a Code Repository: the remote is the base branch's source of truth.");
  });

  it('words the direct-mode refusal from the Isolation Mode', () => {
    const refusal = workspaceRefusal('k8s-prod', 'mintopia/harmonic');
    expect(refusal.link).toBeNull();
    expect(plain(refusal.parts)).toBe('Kubernetes targets are not available to a Workspace in direct mode. Switch the Isolation Mode to worktree first.');
  });
});

describe('rotate signing key copy', () => {
  it('says who loses git access, counting running Tickets', () => {
    expect(rotateKeyCopy('k8s-prod', 2).running.map((p) => p.text).join('')).toBe('2 Tickets are running on k8s-prod now. Their next checkpoint push fails until they start a new pod.');
    expect(rotateKeyCopy('k8s-prod', 1).running[0]?.text).toBe('1 Ticket is running on ');
    expect(rotateKeyCopy('k8s-prod', 0).running.map((p) => p.text).join('')).toContain('No Tickets are running');
  });

  it('summarises the revoked passes and the key age', () => {
    expect(rotatedSummary(2)).toBe('Rotated just now · 2 passes revoked.');
    expect(rotatedSummary(1)).toBe('Rotated just now · 1 pass revoked.');
    const day = 86_400_000;
    expect(daysAgo(0, 28 * day + 5)).toBe('28 days ago');
    expect(daysAgo(0, day + 1)).toBe('1 day ago');
    expect(daysAgo(0, 1000)).toBe('today');
  });
});

describe('proxy key check panel', () => {
  it('uses the mockup wording when the proxy rejects the pass', () => {
    expect(proxyCheckPanel('rejected')).toEqual({
      tone: 'fail',
      title: 'Repository Proxy rejected the last pass.',
      body: 'The proxy is likely still on the old key. Update it, then Test connection.',
    });
    expect(proxyCheckPanel('agrees').tone).toBe('ok');
    expect(proxyCheckPanel('unreachable').tone).toBe('fail');
  });
});

describe('credentials', () => {
  const claude: TargetCredential = { harness: 'claude', kind: 'oauth-token', harnessConfigured: true, set: true, secretName: 'k8s-prod-claude-token', updatedAt: '2026-10-12T09:00:00Z' };
  const codex: TargetCredential = { harness: 'codex', kind: 'api-key', harnessConfigured: true, set: false, secretName: 'k8s-prod-codex-key', updatedAt: null };

  it('shows a set Claude subscription token with its Secret and rotation date', () => {
    const view = credentialRowView(claude);
    expect(view).toMatchObject({ label: 'Claude', pillLabel: 'set', pillTone: 'set', kindLabel: 'Claude subscription · OAuth token', secretName: 'k8s-prod-claude-token', rotated: 'last rotated Oct 12', note: null, replaceLabel: 'Replace…', canClear: true });
  });

  it('warns that a configured Harness without a Secret will escalate', () => {
    const view = credentialRowView(codex);
    expect(view).toMatchObject({ pillTone: 'unset', kindLabel: 'API key', secretName: null, replaceLabel: 'Add API key…', canClear: false });
    expect(view.note).toBe('No Secret yet. Steps that use Codex on this target will escalate.');
  });

  it('shows an unconfigured Harness as optional', () => {
    const view = credentialRowView({ ...codex, harness: 'opencode', harnessConfigured: false });
    expect(view.pillTone).toBe('optional');
    expect(view.note).toBe('Not configured as a Harness in this Harmonic, so nothing needs it.');
  });

  it('gives the Claude panel the setup-token command and other Harnesses none', () => {
    const copy = credentialPanelCopy(claude);
    expect(copy.title).toBe('Replace the Claude token');
    expect(copy.fieldLabel).toBe('New Claude subscription token');
    expect(copy.help.command).toBe('claude setup-token');
    expect(copy.stored.map((p) => p.text).join('')).toBe('Stored as the Secret k8s-prod-claude-token. Existing pods keep the old token until they end.');
    expect(credentialPanelCopy(codex).help.command).toBeNull();
    expect(credentialPanelCopy(codex).title).toBe('Add the Codex API key');
  });
});
