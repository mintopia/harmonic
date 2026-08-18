import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import type { EpicLandOutcome } from '../src/execution/epic-land-coordinator.js';

async function mcpClient(server: TestServer, token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport as any);
  return client;
}
const parse = (result: any) => JSON.parse(result.content[0].text);

/**
 * The operator force-land-the-ready-subset surface over a whole Epic (issue
 * #161, ADR-0024), over both REST and MCP. `TrackerPollerManager.forceLandEpic`
 * itself (src/tracker/manager.ts) is already covered by
 * epic-land-coordinator.test.ts; these tests exercise the operator-facing
 * plumbing around it — routing, param parsing, the null→404/409 mapping, and
 * the operator-only auth gate — spying on the manager rather than standing up
 * a real tracker loop.
 */
describe('Whole-Epic force-land operator surface (issue #161)', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startServer(stubHarness());
  });
  afterEach(async () => {
    await server.close();
  });

  const ctx = () => server.app.ctx;
  const defaultWorkspaceId = () => ctx().workspaces.list()[0]!.id;

  describe('POST /api/workspaces/:workspaceId/epics/:epicRef/force-land', () => {
    it('returns the outcome from TrackerPollerManager.forceLandEpic on a 200', async () => {
      const outcome: EpicLandOutcome = { status: 'landed', oid: 'deadbeef' };
      const spy = vi.spyOn(ctx().trackerManager, 'forceLandEpic').mockResolvedValue(outcome);

      const res = await server.api('POST', `/api/workspaces/${defaultWorkspaceId()}/epics/42/force-land`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(outcome);
      expect(spy).toHaveBeenCalledWith(defaultWorkspaceId(), 42);
    });

    it('passes through a non-landed outcome (e.g. escalated) unchanged', async () => {
      const outcome: EpicLandOutcome = { status: 'escalated', reason: 'whole-Epic verification failed' };
      vi.spyOn(ctx().trackerManager, 'forceLandEpic').mockResolvedValue(outcome);

      const res = await server.api('POST', `/api/workspaces/${defaultWorkspaceId()}/epics/42/force-land`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(outcome);
    });

    it('404s when the Workspace does not exist', async () => {
      const res = await server.api('POST', '/api/workspaces/999999/epics/42/force-land');
      expect(res.status).toBe(404);
    });

    it('409s when the Workspace exists but has no active land coordinator (tracking off, the default in tests)', async () => {
      const res = await server.api('POST', `/api/workspaces/${defaultWorkspaceId()}/epics/42/force-land`);
      expect(res.status).toBe(409);
    });

    it('400s on a non-numeric workspaceId or epicRef', async () => {
      expect((await server.api('POST', '/api/workspaces/abc/epics/42/force-land')).status).toBe(400);
      expect((await server.api('POST', `/api/workspaces/${defaultWorkspaceId()}/epics/xyz/force-land`)).status).toBe(400);
    });
  });

  describe('operator-only gating', () => {
    it('denies a run-scoped Run Key on POST /api/workspaces/:id/epics/:ref/force-land', async () => {
      const created = await server.api('POST', '/api/tasks', {
        prompt: JSON.stringify({ echoEnv: ['HARMONIC_API_KEY'], exit: 'hang' }),
      });
      const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
      const echo = await waitFor(async () => {
        const { body } = await server.api('GET', `/api/runs/${started.body.id}/events`);
        return body.events.find((e: any) => e.payload?.content?.text?.startsWith('{'));
      });
      const token = JSON.parse(echo.payload.content.text).HARMONIC_API_KEY;

      const res = await fetch(`${server.baseUrl}/api/workspaces/${defaultWorkspaceId()}/epics/42/force-land`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(403);
    });

    it('denies a read-scoped key', async () => {
      const { body } = await server.api('POST', '/api/keys', { name: 'viz', scope: 'read' });
      const res = await fetch(`${server.baseUrl}/api/workspaces/${defaultWorkspaceId()}/epics/42/force-land`, {
        method: 'POST',
        headers: { authorization: `Bearer ${body.token}` },
      });
      expect(res.status).toBe(403);
    });
  });
});

describe('force_land_epic MCP tool (issue #161)', () => {
  let server: TestServer;
  let operatorToken: string;

  beforeAll(async () => {
    server = await startServer(stubHarness());
    const key = await server.api('POST', '/api/keys', { name: 'mcp-operator' });
    operatorToken = key.body.token;
  });
  afterAll(async () => {
    await server.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ctx = () => server.app.ctx;
  const defaultWorkspaceId = () => ctx().workspaces.list()[0]!.id;

  it('is registered and returns the outcome to a full-scope operator key', async () => {
    const client = await mcpClient(server, operatorToken);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['force_land_epic']));

    const outcome: EpicLandOutcome = { status: 'landed', oid: 'cafef00d' };
    const spy = vi.spyOn(ctx().trackerManager, 'forceLandEpic').mockResolvedValue(outcome);

    const result = parse(
      await client.callTool({
        name: 'force_land_epic',
        arguments: { workspaceId: defaultWorkspaceId(), epicRef: 7 },
      }),
    );
    expect(result).toEqual(outcome);
    expect(spy).toHaveBeenCalledWith(defaultWorkspaceId(), 7);

    await client.close();
  });

  it('reports a not-found/conflict domain error, not a raw 500, when tracking is off for the Workspace', async () => {
    const client = await mcpClient(server, operatorToken);
    const result = await client.callTool({
      name: 'force_land_epic',
      arguments: { workspaceId: defaultWorkspaceId(), epicRef: 7 },
    });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('no active whole-Epic land coordinator');
    await client.close();
  });

  it('validates its input (rejects a missing epicRef)', async () => {
    const client = await mcpClient(server, operatorToken);
    const result = await client.callTool({
      name: 'force_land_epic',
      arguments: { workspaceId: defaultWorkspaceId() },
    });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('epicRef');
    await client.close();
  });

  it('rejects a run-scoped Run Key with a forbidden domain error, even though /mcp itself admits it', async () => {
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ echoEnv: ['HARMONIC_API_KEY'], exit: 'hang' }),
    });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    const echo = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/runs/${started.body.id}/events`);
      return body.events.find((e: any) => e.payload?.content?.text?.startsWith('{'));
    });
    const runToken = JSON.parse(echo.payload.content.text).HARMONIC_API_KEY;

    const client = await mcpClient(server, runToken);
    const forbidden = await client.callTool({
      name: 'force_land_epic',
      arguments: { workspaceId: defaultWorkspaceId(), epicRef: 7 },
    });
    expect(forbidden.isError).toBe(true);
    expect((forbidden.content as any)[0].text).toContain('forbidden');
    await client.close();
  });
});
