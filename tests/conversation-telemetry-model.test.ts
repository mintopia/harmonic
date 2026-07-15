import { describe, expect, it } from 'vitest';
import {
  computeContextUsage,
  formatColdCacheMessage,
  formatContextUsage,
  formatTokens,
  isColdCache,
  totalTokens,
  type ContextUsage,
} from '../web/src/conversation-telemetry-model.js';
import type { Conversation } from '../web/src/types.js';

describe('totalTokens', () => {
  it('is null when usage itself is null (no Turn has completed yet)', () => {
    expect(totalTokens(null)).toBeNull();
  });

  it('is null when usage exists but totals is null', () => {
    expect(totalTokens({ totals: null, models: {}, toolCalls: {}, source: null })).toBeNull();
  });

  it('prefers the harness-reported totalTokens when present', () => {
    const usage: Conversation['usage'] = {
      totals: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0, totalTokens: 999 },
      models: {},
      toolCalls: {},
      source: 'acp',
    };
    expect(totalTokens(usage)).toBe(999);
  });

  it('sums the four counters when totalTokens is not reported', () => {
    const usage: Conversation['usage'] = {
      totals: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 3, totalTokens: null },
      models: {},
      toolCalls: {},
      source: 'acp',
    };
    expect(totalTokens(usage)).toBe(118);
  });
});

describe('formatTokens', () => {
  it('renders "no usage yet" — never a fake zero — before any usage lands', () => {
    expect(formatTokens(null)).toBe('no usage yet');
  });

  it('renders large counts compactly', () => {
    const usage: Conversation['usage'] = {
      totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 18_200 },
      models: {},
      toolCalls: {},
      source: 'acp',
    };
    expect(formatTokens(usage)).toBe('18.2k');
  });
});

const conv = (over: Partial<Pick<Conversation, 'contextTokens' | 'contextWindow'>>) => ({
  contextTokens: null,
  contextWindow: null,
  ...over,
});

describe('computeContextUsage', () => {
  it('is unknown when contextTokens is null — no percentage, no raw count', () => {
    expect(computeContextUsage(conv({}))).toEqual({ kind: 'unknown' });
  });

  it('reports raw tokens when the window is unconfigured (honest degradation)', () => {
    expect(computeContextUsage(conv({ contextTokens: 4000, contextWindow: null }))).toEqual({
      kind: 'raw',
      tokens: 4000,
    });
  });

  it('computes a real percentage when both are known', () => {
    expect(computeContextUsage(conv({ contextTokens: 5000, contextWindow: 20_000 }))).toEqual({
      kind: 'percent',
      tokens: 5000,
      window: 20_000,
      pct: 25,
    });
  });

  it('does not clamp an over-window fraction — the number stays honest', () => {
    const usage = computeContextUsage(conv({ contextTokens: 25_000, contextWindow: 20_000 }));
    expect(usage).toEqual({ kind: 'percent', tokens: 25_000, window: 20_000, pct: 125 });
  });
});

describe('formatContextUsage', () => {
  it('shows a muted dash for unknown', () => {
    expect(formatContextUsage({ kind: 'unknown' })).toEqual({ value: '—', note: null });
  });

  it('shows raw tokens with a "window unknown" caveat', () => {
    expect(formatContextUsage({ kind: 'raw', tokens: 4200 })).toEqual({
      value: '4.2k tokens',
      note: 'window unknown',
    });
  });

  it('shows a rounded percentage with no caveat', () => {
    expect(formatContextUsage({ kind: 'percent', tokens: 5000, window: 20_000, pct: 25 })).toEqual({
      value: '25%',
      note: null,
    });
  });

  it('shows an honest over-100% figure rather than capping it', () => {
    const over: ContextUsage = { kind: 'percent', tokens: 25_000, window: 20_000, pct: 125 };
    expect(formatContextUsage(over)).toEqual({ value: '125%', note: null });
  });
});

describe('isColdCache / formatColdCacheMessage', () => {
  const base = { updatedAt: 1_000_000, cacheTtlSeconds: 300 };

  it('never warns when the TTL is unconfigured, however idle', () => {
    expect(isColdCache({ updatedAt: 0, cacheTtlSeconds: null, now: Date.now() })).toBe(false);
    expect(formatColdCacheMessage({ updatedAt: 0, cacheTtlSeconds: null, now: Date.now() })).toBeNull();
  });

  it('is false while idle time is within the TTL', () => {
    const now = base.updatedAt + 100_000; // 100s idle, 300s TTL
    expect(isColdCache({ ...base, now })).toBe(false);
    expect(formatColdCacheMessage({ ...base, now })).toBeNull();
  });

  it('is true once idle time exceeds the TTL, worded as an estimate', () => {
    const now = base.updatedAt + 400_000; // 400s idle, 300s (5m) TTL
    expect(isColdCache({ ...base, now })).toBe(true);
    expect(formatColdCacheMessage({ ...base, now })).toBe('Cache likely cold — idle 6m, TTL 5m (estimate)');
  });

  it('is exactly false at the TTL boundary (idle must exceed, not just reach, the TTL)', () => {
    const now = base.updatedAt + base.cacheTtlSeconds * 1000;
    expect(isColdCache({ ...base, now })).toBe(false);
  });
});
