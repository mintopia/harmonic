#!/usr/bin/env node
// Stub harness: a scripted ACP agent used as the driven test seam.
// It speaks real ndjson JSON-RPC on stdio, exactly like a production
// adapter. The *prompt text* of session/prompt is the scenario script:
//
// {
//   "updates":  [ <session/update `update` objects, sent in order> ],
//   "delayMs":  10,                     // pause between updates
//   "requestPermission": { "title": "Write file" },  // ask mid-stream
//   "echoEnv":  ["AGENTDECK_MCP_URL"],  // emit env values as a chunk
//   "stopReason": "end_turn",
//   "usage":    { "inputTokens": 1, "outputTokens": 2 },
//   "exit":     "clean" | "crash-before-response" | "hang"
// }
//
// A non-JSON prompt runs a two-chunk "hello" scenario.
import { createInterface } from 'node:readline';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

let nextOutId = 1000;
const pendingOut = new Map();
const request = (method, params) => {
  const id = nextOutId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve) => pendingOut.set(id, resolve));
};
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

const sessionId = `stub-${process.pid}`;

async function handlePrompt(msg) {
  let scenario;
  try {
    scenario = JSON.parse(msg.params.prompt[0].text);
  } catch {
    // Non-JSON prompt: echo it back, so tests can assert what prompt
    // actually reached the harness.
    scenario = {
      updates: [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `prompt-received:${msg.params.prompt[0].text}` },
        },
      ],
    };
  }
  const delayMs = scenario.delayMs ?? 5;

  for (const update of scenario.updates ?? []) {
    await sleep(delayMs);
    notify('session/update', { sessionId: msg.params.sessionId, update });
  }

  if (scenario.echoEnv) {
    const values = Object.fromEntries(scenario.echoEnv.map((k) => [k, process.env[k] ?? null]));
    notify('session/update', {
      sessionId: msg.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(values) } },
    });
  }

  if (scenario.requestPermission) {
    const outcome = await request('session/request_permission', {
      sessionId: msg.params.sessionId,
      toolCall: { toolCallId: 'stub-tool-1', title: scenario.requestPermission.title ?? 'Do something' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    notify('session/update', {
      sessionId: msg.params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `permission:${JSON.stringify(outcome)}` },
      },
    });
  }

  const exit = scenario.exit ?? 'clean';
  if (exit === 'crash-before-response') process.exit(1);
  if (exit === 'hang') return; // never respond; must be killed
  send({
    jsonrpc: '2.0',
    id: msg.id,
    result: { stopReason: scenario.stopReason ?? 'end_turn', ...(scenario.usage ? { usage: scenario.usage } : {}) },
  });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.result !== undefined && pendingOut.has(msg.id)) {
    pendingOut.get(msg.id)(msg.result);
    pendingOut.delete(msg.id);
    return;
  }
  switch (msg.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      break;
    case 'session/new':
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId } });
      break;
    case 'session/prompt':
      handlePrompt(msg);
      break;
    default:
      if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: null });
  }
});
