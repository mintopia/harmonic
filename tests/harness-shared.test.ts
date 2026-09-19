import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializedTailReader } from '../src/execution/harness/adapter.js';
import { datedLogFiles, agentFiles, agentFilesSync } from '../src/execution/harness/session-files.js';
import { mergeModelUsage } from '../src/execution/harness/model-usage.js';
import type { ParsedSession } from '../src/execution/usage.js';
import type { ModelUsage } from '../src/domain/usage.js';

const parsed = (tag: string): ParsedSession =>
  ({
    usage: {},
    tree: { id: tag, name: 'root', model: 'unknown', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, contextTokens: null, lastTool: null, status: 'active', depth: 0, toolUseId: null, children: [] },
    turns: [],
  }) as unknown as ParsedSession;

describe('serializedTailReader', () => {
  it('serializes overlapping sample() calls, passing the prior resolved value forward', async () => {
    const calls: Array<ParsedSession | null> = [];
    let resolveFirst!: (v: ParsedSession | null) => void;
    const firstGate = new Promise<ParsedSession | null>((resolve) => (resolveFirst = resolve));
    let callCount = 0;

    const doSample = async (previous: ParsedSession | null): Promise<ParsedSession | null> => {
      callCount++;
      calls.push(previous);
      if (callCount === 1) return firstGate;
      return parsed('second');
    };

    const reader = serializedTailReader(doSample);

    const p1 = reader.sample();
    const p2 = reader.sample();

    // Give the microtask queue a chance to run; the second doSample must not
    // have started yet because the first hasn't resolved.
    await Promise.resolve();
    await Promise.resolve();
    expect(callCount).toBe(1);

    resolveFirst(parsed('first'));
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(callCount).toBe(2);
    expect(calls[0]).toBeNull();
    expect(calls[1]).toEqual(parsed('first'));
    expect(r1).toEqual(parsed('first'));
    expect(r2).toEqual(parsed('second'));
    expect(reader.latest()).toEqual(parsed('second'));
  });

  it('a rejecting doSample does not poison the chain, and latest() keeps the last good parse', async () => {
    let call = 0;
    const doSample = async (previous: ParsedSession | null): Promise<ParsedSession | null> => {
      call++;
      if (call === 1) return parsed('good');
      if (call === 2) throw new Error('boom');
      return previous;
    };
    const reader = serializedTailReader(doSample);

    await expect(reader.sample()).resolves.toEqual(parsed('good'));
    expect(reader.latest()).toEqual(parsed('good'));

    await expect(reader.sample()).rejects.toThrow('boom');
    expect(reader.latest()).toEqual(parsed('good'));

    await expect(reader.sample()).resolves.toEqual(parsed('good'));
    expect(call).toBe(3);
  });
});

describe('datedLogFiles', () => {
  let dir: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('yields matching files newest-first across a dated tree, skipping non-matching basenames', () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-dated-'));
    const mk = (y: string, m: string, d: string, file: string) => {
      const dayDir = join(dir, y, m, d);
      mkdirSync(dayDir, { recursive: true });
      writeFileSync(join(dayDir, file), 'x');
    };
    mk('2024', '01', '01', 'rollout-a.jsonl');
    mk('2024', '01', '01', 'ignore-me.txt');
    mk('2024', '06', '15', 'rollout-b.jsonl');
    mk('2025', '02', '10', 'rollout-c.jsonl');

    const match = (name: string) => name.startsWith('rollout-') && name.endsWith('.jsonl');
    const files = [...datedLogFiles(dir, match)];

    expect(files).toEqual([join(dir, '2025', '02', '10', 'rollout-c.jsonl'), join(dir, '2024', '06', '15', 'rollout-b.jsonl'), join(dir, '2024', '01', '01', 'rollout-a.jsonl')]);
  });

  it('yields nothing for a missing root', () => {
    dir = join(tmpdir(), 'harmonic-dated-missing-does-not-exist');
    const files = [...datedLogFiles(dir, () => true)];
    expect(files).toEqual([]);
  });
});

describe('agentFiles / agentFilesSync', () => {
  let dir: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('pairs a .jsonl with its .meta.json by id, keeping a stem with only one half', async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-agent-files-'));
    writeFileSync(join(dir, 'agent-abc.jsonl'), '');
    writeFileSync(join(dir, 'agent-abc.meta.json'), '{}');
    writeFileSync(join(dir, 'agent-onlyjsonl.jsonl'), '');
    writeFileSync(join(dir, 'agent-onlymeta.meta.json'), '{}');

    const expectPairs = (found: Map<string, { id: string; jsonl?: string; meta?: string }>) => {
      expect(found.size).toBe(3);
      const abc = found.get('abc')!;
      expect(abc.jsonl).toBe(join(dir, 'agent-abc.jsonl'));
      expect(abc.meta).toBe(join(dir, 'agent-abc.meta.json'));

      const onlyJsonl = found.get('onlyjsonl')!;
      expect(onlyJsonl.jsonl).toBe(join(dir, 'agent-onlyjsonl.jsonl'));
      expect(onlyJsonl.meta).toBeUndefined();

      const onlyMeta = found.get('onlymeta')!;
      expect(onlyMeta.meta).toBe(join(dir, 'agent-onlymeta.meta.json'));
      expect(onlyMeta.jsonl).toBeUndefined();
    };

    expectPairs(agentFilesSync(dir));
    expectPairs(await agentFiles(dir));
  });

  it('returns an empty map for a missing dir', async () => {
    dir = join(tmpdir(), 'harmonic-agent-files-missing-does-not-exist');
    expect(agentFilesSync(dir).size).toBe(0);
    expect((await agentFiles(dir)).size).toBe(0);
  });
});

describe('mergeModelUsage', () => {
  it('sums per-model records into a fresh record without mutating any input', () => {
    const a: Record<string, ModelUsage> = { 'model-a': { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } };
    const b: Record<string, ModelUsage> = {
      'model-a': { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
      'model-b': { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 },
    };
    const aSnapshot = JSON.parse(JSON.stringify(a));
    const bSnapshot = JSON.parse(JSON.stringify(b));

    const merged = mergeModelUsage([a, b]);

    expect(merged).toEqual({
      'model-a': { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44 },
      'model-b': { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 },
    });
    expect(a).toEqual(aSnapshot);
    expect(b).toEqual(bSnapshot);
  });
});
