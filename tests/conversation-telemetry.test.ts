import { describe, it, expect, afterEach } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { accumulateUsage, contextInputTokens, type AttemptUsage } from '../src/execution/usage.js';

const acpTurn = (usage: Record<string, number>) => JSON.stringify({ updates: [], usage });

describe('conversation usage accumulation (unit)', () => {
  const aggregate = (t: Partial<AttemptUsage['totals'] & object>): AttemptUsage => ({
    models: {},
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: null, ...t },
    toolCalls: {},
    source: 'acp',
  });

  it('accumulates ACP-aggregate totals across Turns', () => {
    const a = aggregate({ inputTokens: 100, outputTokens: 50 });
    const b = aggregate({ inputTokens: 200, outputTokens: 30 });
    const merged = accumulateUsage(a, b)!;
    expect(merged.totals).toMatchObject({ inputTokens: 300, outputTokens: 80 });
  });

  it('replaces with a cumulative per-model source (session log)', () => {
    const stored = aggregate({ inputTokens: 100, outputTokens: 50 });
    const cumulative: AttemptUsage = {
      models: { 'claude-sonnet-5': { inputTokens: 999, outputTokens: 999, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      totals: null,
      toolCalls: {},
      source: 'session-log',
    };
    expect(accumulateUsage(stored, cumulative)).toBe(cumulative);
  });

  it('derives context fill from the input side of an ACP result', () => {
    expect(contextInputTokens({ inputTokens: 10, cachedReadTokens: 5, cachedWriteTokens: 2 })).toBe(17);
    expect(contextInputTokens(undefined)).toBeNull();
  });
});

describe('conversation telemetry (issue 12)', () => {
  let server: TestServer;
  afterEach(async () => {
    await server?.close();
  });

  it('accumulates running tokens across Turns and tracks the latest context fill', async () => {
    server = await startServer(stubHarness());
    const { body: convo } = await server.api('POST', '/api/conversations', {});

    await server.api('POST', `/api/conversations/${convo.id}/turns`, { text: acpTurn({ inputTokens: 100, outputTokens: 50 }) });
    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/conversations/${convo.id}`);
      return body.usage?.totals?.outputTokens === 50 ? body : undefined;
    });

    await server.api('POST', `/api/conversations/${convo.id}/turns`, { text: acpTurn({ inputTokens: 200, outputTokens: 30 }) });
    const after = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/conversations/${convo.id}`);
      return body.usage?.totals?.outputTokens === 80 ? body : undefined;
    });
    // Running tokens accumulate; context fill is the LATEST Turn's input.
    expect(after.usage.totals).toMatchObject({ inputTokens: 300, outputTokens: 80 });
    expect(after.contextTokens).toBe(200);
  });

  it('follows the honest-incomplete rule for cost when no per-model split is available', async () => {
    server = await startServer(stubHarness());
    const { body: convo } = await server.api('POST', '/api/conversations', {});
    await server.api('POST', `/api/conversations/${convo.id}/turns`, { text: acpTurn({ inputTokens: 100, outputTokens: 50 }) });
    const after = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/conversations/${convo.id}`);
      return body.usage ? body : undefined;
    });
    // Aggregate-only usage cannot be attributed to a priced model — flagged
    // incomplete, never a fake zero.
    expect(after.cost.incomplete).toBe(true);
    expect(after.cost.totalUsd).toBeNull();
  });

  it('suppresses the window and TTL when unconfigured (honest degradation)', async () => {
    server = await startServer(stubHarness());
    const { body: convo } = await server.api('POST', '/api/conversations', {});
    expect(convo.contextWindow).toBeNull();
    expect(convo.cacheTtlSeconds).toBeNull();
  });

  it('exposes contextWindow and cacheTtlSeconds when configured per model', async () => {
    server = await startServer({
      ...stubHarness(),
      modelInfo: { 'stub-model': { contextWindow: 1000, cacheTtlSeconds: 60 } },
    });
    const { body: convo } = await server.api('POST', '/api/conversations', {});
    expect(convo.contextWindow).toBe(1000);
    expect(convo.cacheTtlSeconds).toBe(60);
  });
});
