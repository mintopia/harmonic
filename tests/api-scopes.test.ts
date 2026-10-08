import { describe, it, expect } from 'vitest';
import { scopedKeyAllowed, readScopeAllowed, keyScopesFor, describeKeyScopes, readScopeLabels, readScopePathList } from '../src/server/key-scopes.js';
import { PUBLIC_API_PATHS } from '../src/server/app-auth-hook.js';
import { startServer } from './helpers.js';

it('enforces operator-only routes for encoded and noncanonical task ids', async () => {
  const server = await startServer();
  try {
    const task = await server.app.ctx.tasks.create({ prompt: 'scope regression' });
    for (const scope of ['attempt', 'conversation', 'read'] as const) {
      const { token } = await server.app.ctx.auth.createKey('scope regression', { scope });
      const headers = { authorization: `Bearer ${token}` };
      for (const id of [String(task.id), `%${task.id.toString().charCodeAt(0).toString(16)}${String(task.id).slice(1)}`, `${task.id}e0`]) {
        for (const action of ['accept', 'retry', 'close', 'complete', 'steer']) {
          const response = await server.app.inject({ method: 'POST', url: `/api/tasks/${id}/${action}`, headers, payload: {} });
          expect(response.statusCode, `${scope} ${id}/${action}`).toBe(403);
        }
        const response = await server.app.inject({ method: 'GET', url: `/api/tasks/${id}/channels`, headers });
        expect(response.statusCode, `${scope} ${id}/channels`).toBe(403);
      }
      const response = await server.app.inject({ method: 'GET', url: `/api/tasks/${task.id}`, headers });
      expect(response.statusCode).toBe(200);
    }
  } finally {
    await server.close();
  }
});

it('rejects attempt-scoped and read keys on the secrets, tracker, repository, detection and Agent Message thread routes', async () => {
  const server = await startServer();
  try {
    const routes: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string }[] = [
      ...(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).flatMap((method) => [
        { method, url: '/api/workspaces/1/secrets' },
        { method, url: '/api/workspaces/1/secrets/TOKEN' },
      ]),
      { method: 'GET', url: '/api/agent-messages/threads' },
      { method: 'POST', url: '/api/workspaces/1/tracker/verify' },
      { method: 'POST', url: '/api/workspaces/1/repository/verify' },
      { method: 'GET', url: '/api/workspaces/1/tracker-detection' },
    ];
    for (const scope of ['attempt', 'read'] as const) {
      const { token } = await server.app.ctx.auth.createKey('scope secrets', { scope });
      const headers = { authorization: `Bearer ${token}` };
      for (const { method, url } of routes) {
        const response = await server.app.inject({ method, url, headers, payload: method === 'GET' ? undefined : {} });
        expect(response.statusCode, `${scope} ${method} ${url}`).toBe(403);
      }
    }
  } finally {
    await server.close();
  }
});

it('a read-scoped key sees only id, name and color from GET /api/workspaces', async () => {
  const server = await startServer();
  try {
    const { token } = await server.app.ctx.auth.createKey('viz', { scope: 'read' });
    const response = await server.app.inject({ method: 'GET', url: '/api/workspaces', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    const { workspaces } = response.json() as { workspaces: Record<string, unknown>[] };
    expect(workspaces.length).toBeGreaterThan(0);
    for (const workspace of workspaces) expect(Object.keys(workspace).sort()).toEqual(['color', 'id', 'name']);
  } finally {
    await server.close();
  }
});

describe('scope rule path boundaries', () => {
  it('does not match sibling prefixes of /mcp and /api/attempts', () => {
    for (const path of ['/mcpfoo', '/api/attemptsX']) {
      expect(scopedKeyAllowed(path), path).toBe(false);
      expect(readScopeAllowed(path, 'GET'), path).toBe(false);
    }
  });
});

describe('read scope prose', () => {
  it('lists every read-allowed rule', () => {
    const prose = readScopePathList();
    for (const path of ['/api/ws', '/api/scheduled-jobs', '/api/notifications']) {
      expect(readScopeAllowed(path, 'GET')).toBe(true);
      expect(prose).toContain(path);
    }
    for (const label of readScopeLabels()) expect(prose).toContain(label);
  });
});

describe('scopedKeyAllowed', () => {
  it('allows /mcp regardless of the rest of the path', () => {
    expect(scopedKeyAllowed('/mcp')).toBe(true);
    expect(scopedKeyAllowed('/mcp/anything')).toBe(true);
  });

  it('blocks completing or steering an attempt', () => {
    expect(scopedKeyAllowed('/api/tasks/1/complete')).toBe(false);
    expect(scopedKeyAllowed('/api/tasks/42/steer')).toBe(false);
  });

  it('blocks the human-only accept/retry/close dispositions', () => {
    expect(scopedKeyAllowed('/api/tasks/1/accept')).toBe(false);
    expect(scopedKeyAllowed('/api/tasks/1/retry')).toBe(false);
    expect(scopedKeyAllowed('/api/tasks/1/close')).toBe(false);
  });

  it('blocks epic-reject on Epics', () => {
    expect(scopedKeyAllowed('/api/workspaces/1/epics/2/retry')).toBe(false);
  });

  it('blocks the Epic surface generally, listed or by id', () => {
    expect(scopedKeyAllowed('/api/workspaces/1/epics')).toBe(false);
    expect(scopedKeyAllowed('/api/workspaces/1/epics/2')).toBe(false);
  });

  it('blocks Task channels', () => {
    expect(scopedKeyAllowed('/api/tasks/1/channels')).toBe(false);
    expect(scopedKeyAllowed('/api/tasks/1/channels/5')).toBe(false);
  });

  it('allows the rest of the task and attempt surface', () => {
    expect(scopedKeyAllowed('/api/tasks')).toBe(true);
    expect(scopedKeyAllowed('/api/tasks/1')).toBe(true);
    expect(scopedKeyAllowed('/api/tasks/1/attempts')).toBe(true);
    expect(scopedKeyAllowed('/api/attempts')).toBe(true);
    expect(scopedKeyAllowed('/api/attempts/1')).toBe(true);
  });

  it('denies everything else, e.g. the operator surface', () => {
    expect(scopedKeyAllowed('/api/keys')).toBe(false);
    expect(scopedKeyAllowed('/api/config')).toBe(false);
    expect(scopedKeyAllowed('/api/channels')).toBe(false);
  });
});

describe('readScopeAllowed', () => {
  it('is GET-only, rejecting every other method even on an allowed path', () => {
    expect(readScopeAllowed('/api/tasks', 'GET')).toBe(true);
    expect(readScopeAllowed('/api/tasks', 'POST')).toBe(false);
    expect(readScopeAllowed('/api/tasks/1', 'PATCH')).toBe(false);
    expect(readScopeAllowed('/api/tasks/1', 'DELETE')).toBe(false);
  });

  it('allows the WebSocket handshake', () => {
    expect(readScopeAllowed('/api/ws', 'GET')).toBe(true);
  });

  it('allows listing Notifications but not marking them read', () => {
    expect(readScopeAllowed('/api/notifications', 'GET')).toBe(true);
    expect(readScopeAllowed('/api/notifications/1/read', 'POST')).toBe(false);
    expect(scopedKeyAllowed('/api/notifications')).toBe(false);
  });

  it('allows GET on Workspaces and the Epic list/detail, but not other Epic routes or mutations', () => {
    expect(readScopeAllowed('/api/workspaces', 'GET')).toBe(true);
    expect(readScopeAllowed('/api/workspaces/1/epics', 'GET')).toBe(true);
    expect(readScopeAllowed('/api/workspaces/1/epics/2', 'GET')).toBe(true);
    expect(readScopeAllowed('/api/workspaces/1/epics/2/diff/files', 'GET')).toBe(false);
    expect(readScopeAllowed('/api/workspaces/1/epics', 'POST')).toBe(false);
  });

  it('blocks Task channels', () => {
    expect(readScopeAllowed('/api/tasks/1/channels', 'GET')).toBe(false);
    expect(readScopeAllowed('/api/tasks/1/channels/5', 'GET')).toBe(false);
  });

  it('allows GET on tasks, attempts, and maps', () => {
    expect(readScopeAllowed('/api/tasks', 'GET')).toBe(true);
    expect(readScopeAllowed('/api/tasks/1', 'GET')).toBe(true);
    expect(readScopeAllowed('/api/attempts', 'GET')).toBe(true);
    expect(readScopeAllowed('/api/attempts/1', 'GET')).toBe(true);
    expect(readScopeAllowed('/api/maps', 'GET')).toBe(true);
    expect(readScopeAllowed('/api/maps/1', 'GET')).toBe(true);
  });

  it('allows GET on activity, operations, and scheduled-jobs', () => {
    expect(readScopeAllowed('/api/activity', 'GET')).toBe(true);
    expect(readScopeAllowed('/api/operations', 'GET')).toBe(true);
    expect(readScopeAllowed('/api/scheduled-jobs', 'GET')).toBe(true);
  });

  it('denies everything else, e.g. the operator surface', () => {
    expect(readScopeAllowed('/api/keys', 'GET')).toBe(false);
    expect(readScopeAllowed('/api/config', 'GET')).toBe(false);
    expect(readScopeAllowed('/api/channels', 'GET')).toBe(false);
  });
});

it('derives the auth hook decision and the OpenAPI scope text from the same key-scope table for every /api route', async () => {
  const server = await startServer();
  try {
    const spec = server.app.swagger() as { paths: Record<string, Record<string, { description?: string }>> };
    const keys = {
      attempt: (await server.app.ctx.auth.createKey('walk attempt', { scope: 'attempt' })).token,
      read: (await server.app.ctx.auth.createKey('walk read', { scope: 'read' })).token,
    };
    let checked = 0;
    for (const [openapiPath, ops] of Object.entries(spec.paths)) {
      if (!openapiPath.startsWith('/api') || PUBLIC_API_PATHS.has(openapiPath)) continue;
      const path = openapiPath.replace(/\{([^}]+)\}/g, ':$1');
      for (const [method, op] of Object.entries(ops)) {
        const upper = method.toUpperCase();
        const scopes = keyScopesFor(path, upper);
        expect(op.description, `${upper} ${path}`).toContain(describeKeyScopes(path, upper));
        for (const scope of ['attempt', 'read'] as const) {
          const url = openapiPath.replace(/\{[^}]+\}/g, '1');
          const response = await server.app.inject({
            method: upper as 'GET',
            url,
            headers: { authorization: `Bearer ${keys[scope]}` },
            payload: upper === 'GET' || upper === 'DELETE' ? undefined : {},
          });
          const forbidden = response.statusCode === 403 && response.json()?.error?.code === 'forbidden';
          expect(forbidden, `${scope} ${upper} ${path}`).toBe(!scopes.includes(scope));
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  } finally {
    await server.close();
  }
});
