import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { baselineConfig } from '../src/config.js';
import type { WorkspaceRow } from '../src/db/schema.js';
import { RouteClassifier, createOpenAiCompatibleClassifierBackend } from '../src/domain/route-classifier.js';

const OPTIONS = [
  { id: 'cheap-fix', harness: 'claude', model: 'claude-haiku-4-5-20251001', description: 'cheap, small fixes' },
  { id: 'deep-work', harness: 'claude', model: 'claude-opus-5-5', description: 'hard work' },
];
const KEY = 'sk-test-super-secret-key';

interface Seen { auth: string | undefined; body: any; path: string | undefined }
type Responder = (res: import('node:http').ServerResponse) => void;

let server: Server;
let respond: Responder;
let seen: Seen;
let baseUrl: string;

const reply = (status: number, body: unknown): Responder => (res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const completion = (content: string) => ({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 120, completion_tokens: 15, total_tokens: 135 },
});

beforeEach(async () => {
  seen = { auth: undefined, body: undefined, path: undefined };
  server = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen = { auth: req.headers.authorization, body: JSON.parse(raw), path: req.url };
      respond(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

function classifier(opts: { timeoutSeconds?: number; secret?: string | null } = {}) {
  const config = { ...baselineConfig(), modelOptions: OPTIONS };
  const workspace = {
    id: 7,
    modelOptions: null,
    classifierEnabled: true,
    classifierBackend: 'openai-compatible',
    classifierTimeoutSeconds: opts.timeoutSeconds ?? 5,
    classifierEndpoint: JSON.stringify({ baseUrl, model: 'gpt-test', apiKeySecret: 'CLASSIFIER_KEY' }),
  } as unknown as WorkspaceRow;
  const revealed: Array<[number, string]> = [];
  const backend = createOpenAiCompatibleClassifierBackend({
    reveal: async (id, name) => {
      revealed.push([id, name]);
      return opts.secret === undefined ? KEY : opts.secret;
    },
  });
  const rc = new RouteClassifier(() => config, { 'openai-compatible': backend });
  const run = () => rc.classify({ workspace, title: 't', description: 'd', labels: [], attemptNumber: 1 });
  return { run, revealed };
}

describe('OpenAI-compatible Route Classifier backend', () => {
  it('sends the enum schema and bearer token, and routes a valid reply', async () => {
    respond = reply(200, completion(JSON.stringify({ optionId: 'deep-work', reason: 'big' })));
    const { run, revealed } = classifier();
    const outcome = await run();
    expect(outcome).toMatchObject({ kind: 'chosen', option: { id: 'deep-work' }, reason: 'big' });
    expect(seen.path).toBe('/v1/chat/completions');
    expect(seen.auth).toBe(`Bearer ${KEY}`);
    expect(seen.body.model).toBe('gpt-test');
    const schema = seen.body.response_format.json_schema;
    expect(seen.body.response_format.type).toBe('json_schema');
    expect(schema.strict).toBe(true);
    expect(schema.schema.properties.optionId.enum).toEqual(['cheap-fix', 'deep-work']);
    expect(revealed).toEqual([[7, 'CLASSIFIER_KEY']]);
    expect(outcome.routing?.usage.totals).toMatchObject({ inputTokens: 120, outputTokens: 15, totalTokens: 135 });
  });

  it.each([
    ['HTTP 500', () => reply(500, { error: 'boom' }), /HTTP 500/],
    ['a schema-violating body', () => reply(200, completion(JSON.stringify({ optionId: 'nope', reason: 'x' }))), /not in the list/],
    ['a body missing fields', () => reply(200, completion(JSON.stringify({ choice: 1 }))), /invalid output/],
    ['non-JSON content', () => reply(200, completion('hello')), /not valid JSON/],
    ['a timeout', () => () => undefined, /abort|timed out|timeout/i],
  ])('abstains on %s without leaking the key', async (name, make, pattern) => {
    respond = make();
    const { run } = classifier({ timeoutSeconds: name === 'a timeout' ? 0.2 : 5 });
    const outcome = await run();
    expect(outcome.kind).toBe('abstained');
    expect(outcome.reason).toMatch(pattern);
    expect(JSON.stringify(outcome)).not.toContain(KEY);
  });

  it('abstains when the Secret is not set', async () => {
    respond = reply(200, completion('{}'));
    const outcome = await classifier({ secret: null }).run();
    expect(outcome).toMatchObject({ kind: 'abstained' });
    expect(outcome.reason).toContain("Secret 'CLASSIFIER_KEY' is not set");
    expect(seen.auth).toBeUndefined();
  });
});
