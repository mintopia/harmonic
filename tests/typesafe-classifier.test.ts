import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { baselineConfig } from '../src/config.js';
import { RouteClassifier, type ClassifierInput } from '../src/domain/route-classifier.js';
import { createTypesafeClassifierBackend } from '../src/domain/typesafe-classifier.js';
import { bundledEnginePrompts } from '../src/domain/bundled-prompts.js';

const KEY = 'sk-or-test-secret-key';
const OPTIONS = [
  { id: 'cheap-fix', harness: 'claude', model: 'claude-haiku-5-5', description: 'cheap, small fixes' },
  { id: 'deep-work', harness: 'claude', model: 'claude-opus-5-5', description: 'hard, cross-cutting work' },
];
const INPUT: ClassifierInput = {
  title: 'Fix typo',
  description: 'README typo',
  labels: ['docs'],
  attemptNumber: 2,
  previousVerdict: 'fail',
  previousFailureReason: 'tests failed',
  options: OPTIONS,
};

describe('TypeSafe classifier backend', () => {
  let server: Server;
  let url: string;
  let seen: { headers: IncomingMessage['headers']; body: any; path: string | undefined } | null;
  let respond: (res: import('node:http').ServerResponse) => void;

  beforeEach(async () => {
    seen = null;
    respond = (res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        answers: { route: { type: 'choice', choice: 'deep-work', confidence: 0.8, probabilities: { 'cheap-fix': 0.2, 'deep-work': 0.8 } } },
        usage: { cost: 0.00002, input_tokens: 400, output_tokens: 50 },
      }));
    };
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen = { headers: req.headers, body: JSON.parse(raw), path: req.url };
        respond(res);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/alpha/decisions`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  const backend = (secret: string | null = KEY) =>
    createTypesafeClassifierBackend({ url, reveal: async () => secret });
  const ctx = (timeoutMs = 2000) => ({
    timeoutMs,
    prompt: 'EDITED ROUTE PROMPT',
    config: baselineConfig(),
    workspace: { id: 7, classifierTypesafeModel: 'typesafe/jev-1.13', classifierTypesafeSecret: 'OR_KEY' } as never,
  });

  it('sends a choice question over the options with the key, maps the decision and records usage', async () => {
    const result = await backend().classify(INPUT, ctx());
    expect(seen!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen!.body.model).toBe('typesafe/jev-1.13');
    expect(seen!.body.questions.route).toMatchObject({
      type: 'choice',
      criteria: { 'cheap-fix': 'cheap, small fixes', 'deep-work': 'hard, cross-cutting work' },
    });
    expect(seen!.body.questions.route.instructions).toBe('EDITED ROUTE PROMPT');
    expect(seen!.body.state).toMatchObject({ title: 'Fix typo', labels: ['docs'], attemptNumber: 2, previousFailureReason: 'tests failed' });
    expect(result.output).toMatchObject({ optionId: 'deep-work' });
    expect(result.usage?.totals).toMatchObject({ inputTokens: 400, outputTokens: 50 });
    expect(result.costUsd).toBeCloseTo(0.00002);
  });

  it('feeds usage and cost to the routing line through the classifier', async () => {
    const classifier = new RouteClassifier(() => baselineConfig(), { typesafe: backend() }, bundledEnginePrompts);
    const workspace = { id: 7, classifierEnabled: true, classifierBackend: 'typesafe', classifierTimeoutSeconds: 5, classifierTypesafeSecret: 'OR_KEY', modelOptions: JSON.stringify(OPTIONS.map((modelOption) => ({ kind: 'local', enabled: true, modelOption }))) } as never;
    const outcome = await classifier.classify({ workspace, title: 't', description: 'd', labels: [], attemptNumber: 1 });
    expect(outcome).toMatchObject({ kind: 'chosen', option: { id: 'deep-work' } });
    expect(outcome.routing?.cost?.totalUsd).toBeCloseTo(0.00002);
    expect(outcome.routing?.usage.totals?.inputTokens).toBe(400);
  });

  it('picks from the list resolved with the Ticket overrides', async () => {
    const classifier = new RouteClassifier(() => baselineConfig(), { typesafe: backend() }, bundledEnginePrompts);
    const workspace = { id: 7, classifierEnabled: true, classifierBackend: 'typesafe', classifierTypesafeSecret: 'OR_KEY', modelOptions: JSON.stringify(OPTIONS.map((modelOption) => ({ kind: 'local', enabled: true, modelOption }))) } as never;
    const modelOptionOverrides = [{ id: 'deep-work', harness: 'codex', model: 'gpt-5-mini' }];
    const outcome = await classifier.classify({ workspace, title: 't', description: 'd', labels: [], attemptNumber: 1, modelOptionOverrides });
    expect(outcome).toMatchObject({ kind: 'chosen', option: { id: 'deep-work', harness: 'codex', model: 'gpt-5-mini' } });
    expect(seen!.body.questions.route.criteria['deep-work']).toBe('hard, cross-cutting work');
  });

  it('abstains on an unknown decision', async () => {
    respond = (res) => res.end(JSON.stringify({ answers: { route: { type: 'choice', choice: 'nope' } } }));
    const classifier = new RouteClassifier(() => ({ ...baselineConfig(), modelOptions: OPTIONS }), { typesafe: backend() }, bundledEnginePrompts);
    const workspace = { id: 7, classifierEnabled: true, classifierBackend: 'typesafe', classifierTypesafeSecret: 'OR_KEY' } as never;
    expect(await classifier.classify({ workspace, title: 't', description: 'd', labels: [], attemptNumber: 1 })).toMatchObject({ kind: 'abstained' });
  });

  it('rejects on an HTTP error without leaking the key', async () => {
    respond = (res) => { res.statusCode = 401; res.end(`bad key ${KEY}`); };
    const error = await backend().classify(INPUT, ctx()).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('401');
    expect((error as Error).message).not.toContain(KEY);
  });

  it('rejects on a malformed response', async () => {
    respond = (res) => res.end('{"answers":{}}');
    await expect(backend().classify(INPUT, ctx())).rejects.toThrow();
  });

  it('times out', async () => {
    respond = () => undefined;
    await expect(backend().classify(INPUT, ctx(50))).rejects.toThrow(/time/i);
  });

  it('rejects when no Secret is configured or set, without calling out', async () => {
    const spy = vi.fn();
    server.on('request', spy);
    await expect(backend().classify(INPUT, { ...ctx(), workspace: { id: 7 } as never })).rejects.toThrow(/Secret/);
    await expect(backend(null).classify(INPUT, ctx())).rejects.toThrow(/Secret/);
    expect(spy).not.toHaveBeenCalled();
  });
});
