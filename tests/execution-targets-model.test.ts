import { describe, expect, it } from 'vitest';
import {
  NEW_TARGET_DRAFT,
  canTestConnection,
  connectionTestRequest,
  deleteCopy,
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
import type { ConnectionTestResult, ExecutionTarget, WorkspaceTargetItem } from '../web/src/types.js';

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
  running: 2,
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
