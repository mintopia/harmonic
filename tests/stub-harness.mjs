#!/usr/bin/env node
// Stub harness: a scripted ACP agent used as the driven test seam.
// It speaks real ndjson JSON-RPC on stdio, exactly like a production
// adapter. The *prompt text* of session/prompt is the scenario script:
//
// {
//   "updates":  [ <session/update `update` objects, sent in order> ],
//   "delayMs":  10,                     // pause between updates
//   "requestPermission": { "title": "Write file" },  // ask mid-stream
//   "echoEnv":  ["HARMONIC_MCP_URL"],  // emit env values as a chunk
//   "echoSessionNew": true,             // emit the session/new params received
//   "stopReason": "end_turn",
//   "usage":    { "inputTokens": 1, "outputTokens": 2 },
//   "exit":     "clean" | "crash-before-response" | "hang"
// }
//
// A non-JSON prompt runs a two-chunk "hello" scenario.
//
// ACP `_session/steering` (mid-turn injection, claude-agent-acp ≥0.69) is
// supported by default: while a prompt turn is in flight the stub streams a
// `steer-injected:<text>` chunk and replies `{ outcome: 'injected' }`; when
// idle it replies `{ outcome: 'promptRequired', reason: 'noRunningTurn' }`.
// Set STUB_NO_STEERING to simulate a harness without the method (a JSON-RPC
// "method not found" error), exercising Harmonic's boundary-queue fallback.
import { createInterface } from 'node:readline';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

// Startup-crash mode: emulate a harness (codex-acp, issue 22) that dies
// mid-handshake with a non-zero exit, writing its real reason only to
// stderr. Harmonic must surface that reason, not a bare exit code.
if (process.env.STUB_STARTUP_STDERR) {
  process.stderr.write(process.env.STUB_STARTUP_STDERR);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

// Session modes shape shared by session/new and session/load (both advertise
// them the same way, and #143's load() re-verifies against whatever it gets
// back from session/load). STUB_MODES (comma-separated) overrides, '' means
// none — to test the fail-closed path.
const stubModes = () => {
  const ids = (process.env.STUB_MODES ?? 'default,auto,bypassPermissions').split(',').filter(Boolean);
  return ids.length ? { currentModeId: ids[0], availableModes: ids.map((id) => ({ id, name: id })) } : undefined;
};

let nextOutId = 1000;
const pendingOut = new Map();
const request = (method, params) => {
  const id = nextOutId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve) => pendingOut.set(id, resolve));
};
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

const sessionId = process.env.STUB_SESSION_ID ?? `stub-${process.pid}`;
let sessionNewParams = null;
let sessionLoadParams = null;
let setModelParams = null;
let setModeParams = null;
// Set by a session/cancel notification; the in-flight prompt loop checks it
// and completes the turn with stopReason 'cancelled' (issue 14).
let cancelRequested = false;
// True while a session/prompt turn is in flight, so `_session/steering` can
// tell "inject into the running turn" from "idle, reply promptRequired".
let promptInFlight = false;

async function handlePrompt(msg) {
  // Harmonic appends an "unattended" reminder (carrying taskId=<n>) to every
  // auto-driven prompt. Capture the id, then strip the reminder so a JSON
  // scenario still parses.
  const rawText = msg.params.prompt[0].text;
  const stubTaskId = Number(rawText.match(/taskId=(\d+)/)?.[1] ?? 0) || null;
  // The JSON scenario is the head of the prompt; strip the markdown sections
  // Harmonic may append after it — the auto-drive "## You are running
  // unattended" reminder, a self-heal turn's "## Verification failed" corrective
  // feedback (issue #137), and a bounded agent re-merge turn's "## Branch
  // consolidation required" corrective feedback (issue #155). These are stripped
  // specifically (not any "## " header) so a re-attempt's "## Feedback from the
  // previous attempt" still leaves the prompt non-JSON, preserving the
  // echo-scenario fallback.
  const jsonText = rawText
    .split('\n\n## You are running unattended')[0]
    .split('\n\n## Verification failed')[0]
    .split('\n\n## Branch consolidation required')[0];
  let scenario;
  try {
    scenario = JSON.parse(jsonText);
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
  // Corrective turns re-drive the SAME builder in a FRESH harness process, so a
  // per-process counter can't tell turn 1 from turn 2. Instead the corrective
  // prompt carries a 1-based marker — "self-heal <n>" for a self-heal (issue
  // #137), or "agent re-merge <n>" for a bounded re-merge (issue #155). A
  // scenario may script a distinct turn per corrective attempt via
  // `turns: [t0, t1, ...]`, indexed by that number (turn 0 = the first,
  // un-corrected turn). Stateless and cross-process. Absent `turns`, behaviour
  // is unchanged.
  if (Array.isArray(scenario.turns)) {
    const healAttempt = Number(rawText.match(/self-heal (\d+)/)?.[1] ?? 0);
    const remergeAttempt = Number(rawText.match(/agent re-merge (\d+)/)?.[1] ?? 0);
    const attempt = Math.max(healAttempt, remergeAttempt);
    const { turns, ...base } = scenario;
    const idx = Math.min(attempt, turns.length - 1);
    scenario = { ...base, ...(turns[idx] ?? {}) };
  }
  promptInFlight = true;
  const delayMs = scenario.delayMs ?? 5;
  cancelRequested = false;

  // Simulate an agent editing files in its working directory.
  for (const [rel, content] of Object.entries(scenario.writeFiles ?? {})) {
    const path = resolve(process.cwd(), rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  // Simulate an agent running raw git in its working directory (issue #151
  // branch-contract tests): each entry is an argv array run as `git -C <cwd>
  // ...argv`, e.g. `["checkout","-b","stray"]`. Best-effort — a failing command
  // is swallowed and the test asserts against the resulting git state.
  for (const argv of scenario.gitExec ?? []) {
    try {
      execFileSync('git', ['-C', process.cwd(), ...argv], { stdio: 'ignore' });
    } catch {
      // ignore; the resulting repo state is what the test checks
    }
  }

  for (const update of scenario.updates ?? []) {
    await sleep(delayMs);
    if (cancelRequested) break;
    notify('session/update', { sessionId: msg.params.sessionId, update });
  }

  // Interrupted mid-turn (issue 14): complete the prompt with a cancelled
  // stop reason and run none of the trailing scenario steps.
  if (cancelRequested) {
    promptInFlight = false;
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'cancelled' } });
    return;
  }

  if (scenario.echoSessionNew) {
    notify('session/update', {
      sessionId: msg.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(sessionNewParams) } },
    });
  }

  // Echo what (if anything) arrived over session/load, so a resume test can
  // assert what actually reached the wire — the fresh mcpServers/creds, cwd,
  // and additionalDirectories (issue #143).
  if (scenario.echoSessionLoad) {
    notify('session/update', {
      sessionId: msg.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(sessionLoadParams) } },
    });
  }

  // Echo what (if anything) arrived over session/set_model before the
  // prompt, so tests can assert the ACP-level model pin went over the wire.
  if (scenario.echoSetModel) {
    notify('session/update', {
      sessionId: msg.params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `set-model:${JSON.stringify(setModelParams)}` },
      },
    });
  }

  if (scenario.echoSetMode) {
    notify('session/update', {
      sessionId: msg.params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `set-mode:${JSON.stringify(setModeParams)}` },
      },
    });
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
      toolCall: {
        toolCallId: 'stub-tool-1',
        title: scenario.requestPermission.title ?? 'Do something',
        kind: scenario.requestPermission.kind ?? 'edit',
      },
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

  // Simulate an agent scheduling follow-up work over MCP, using the
  // scoped key + endpoint injected into its environment.
  if (scenario.mcpCreateTask) {
    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      );
      const client = new Client({ name: 'stub-harness', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(process.env.HARMONIC_MCP_URL), {
        requestInit: { headers: { authorization: `Bearer ${process.env.HARMONIC_API_KEY}` } },
      });
      await client.connect(transport);
      const result = await client.callTool({ name: 'create_task', arguments: scenario.mcpCreateTask });
      await client.close();
      notify('session/update', {
        sessionId: msg.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `mcp-created:${result.content[0].text}` },
        },
      });
    } catch (err) {
      notify('session/update', {
        sessionId: msg.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `mcp-error:${err.message}` },
        },
      });
    }
  }

  // Simulate the agent signalling finish/escalate over MCP mid-turn, using the
  // taskId parsed from the injected reminder.
  for (const [field, tool, extra] of [
    ['mcpFinish', 'finish_task', {}],
    ['mcpEscalate', 'escalate_task', { reason: scenario.mcpEscalate?.reason ?? 'need a human' }],
  ]) {
    if (!scenario[field]) continue;
    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const client = new Client({ name: 'stub-harness', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(process.env.HARMONIC_MCP_URL), {
        requestInit: { headers: { authorization: `Bearer ${process.env.HARMONIC_API_KEY}` } },
      });
      await client.connect(transport);
      const result = await client.callTool({ name: tool, arguments: { taskId: stubTaskId, ...extra } });
      await client.close();
      notify('session/update', {
        sessionId: msg.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${tool}:${result.content[0].text}` } },
      });
    } catch (err) {
      notify('session/update', {
        sessionId: msg.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `mcp-error:${err.message}` } },
      });
    }
  }

  const exit = scenario.exit ?? 'clean';
  if (exit === 'crash-before-response') process.exit(1);
  if (exit === 'hang') return; // never respond; must be killed
  promptInFlight = false;
  send({
    jsonrpc: '2.0',
    id: msg.id,
    result: {
      stopReason: scenario.stopReason ?? 'end_turn',
      ...(scenario.usage ? { usage: scenario.usage } : {}),
      ...(scenario._meta ? { _meta: scenario._meta } : {}),
    },
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
      // Advertise session/load support (issue #141) like a modern ACP adapter,
      // so tests can assert the durable Session's `supportsLoadSession` flag
      // end-to-end. No test asserted the prior empty `agentCapabilities: {}`
      // shape (checked: only tests/sessions.test.ts references it, and those
      // call SessionStore/readLoadSessionCapability directly, bypassing this
      // stub), so this is safe to change. Two env toggles let a #143 load()
      // test simulate a harness that DOESN'T advertise one of the two load
      // capabilities: STUB_NO_LOAD_SESSION flips loadSession to false;
      // STUB_NO_ADDITIONAL_DIRS flips additionalDirectories to false.
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: !process.env.STUB_NO_LOAD_SESSION,
            additionalDirectories: !process.env.STUB_NO_ADDITIONAL_DIRS,
          },
        },
      });
      break;
    case 'session/new':
      sessionNewParams = msg.params;
      // Simulate an unauthenticated harness: session/new fails cleanly
      // (codex-acp shape) while the process stays alive.
      if (process.env.STUB_SESSION_NEW_ERROR) {
        send({ jsonrpc: '2.0', id: msg.id, error: JSON.parse(process.env.STUB_SESSION_NEW_ERROR) });
        break;
      }
      {
        const modes = stubModes();
        send({ jsonrpc: '2.0', id: msg.id, result: { sessionId, ...(modes ? { modes } : {}) } });
      }
      break;
    case 'session/load':
      // The #143 resume handshake: reload a stored Session's harness session
      // id into this (fresh) process. Reply with the same modes shape
      // session/new returns, so AcpDriver.load() can re-verify availableModes
      // against the LIVE (possibly upgraded/downgraded) harness rather than
      // trusting what the original dispatch saw.
      sessionLoadParams = msg.params;
      {
        // #144: a real harness replays the reloaded Session's whole historical
        // session/update stream BEFORE the load response returns. STUB_REPLAY_ON_LOAD
        // (a JSON array of `update` objects) simulates that replay so a quarantine
        // test can assert these arrive tagged as replay while the load is in flight.
        if (process.env.STUB_REPLAY_ON_LOAD) {
          for (const update of JSON.parse(process.env.STUB_REPLAY_ON_LOAD)) {
            notify('session/update', { sessionId: msg.params.sessionId, update });
          }
        }
        const modes = stubModes();
        send({ jsonrpc: '2.0', id: msg.id, result: modes ? { modes } : {} });
      }
      break;
    case 'session/set_model':
      setModelParams = msg.params;
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      break;
    case 'session/set_mode':
      setModeParams = msg.params;
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      break;
    case 'session/prompt':
      handlePrompt(msg);
      break;
    case 'session/cancel':
      cancelRequested = true;
      break;
    case '_session/steering':
      if (process.env.STUB_NO_STEERING) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
      } else if (promptInFlight) {
        const stext = msg.params.prompt?.[0]?.text ?? '';
        notify('session/update', {
          sessionId: msg.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `steer-injected:${stext}` } },
        });
        send({ jsonrpc: '2.0', id: msg.id, result: { outcome: 'injected' } });
      } else {
        send({ jsonrpc: '2.0', id: msg.id, result: { outcome: 'promptRequired', reason: 'noRunningTurn' } });
      }
      break;
    default:
      if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: null });
  }
});
