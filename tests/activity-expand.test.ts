// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityView } from "../web/src/components/ActivityView.js";
import type { ActivityProcess } from "../web/src/types.js";
import { makeConfig } from "./component-smoke-harness.js";

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const subagentUsage = {
  inputTokens: 0,
  outputTokens: 1_000_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const process = (type: "attempt" | "chat"): ActivityProcess => ({
  type,
  attemptId: type === "attempt" ? 1 : null,
  conversationId: type === "chat" ? 2 : null,
  taskId: type === "attempt" ? 4 : null,
  title: type === "attempt" ? "Root Agent" : "Chat Agent",
  workspaceId: 1,
  workspaceName: "Workspace",
  harness: "claude",
  model: "claude-test",
  state: "running",
  isolation: "worktree",
  startedAt: Date.now(),
  trackerRef: type === "attempt" ? 499 : null,
  trackerUrl: null,
  escalated: false,
  usage: null,
  contextTokens: 100,
  contextWindow: 200,
  activity: null,
  tree:
    type === "attempt"
      ? {
          id: "root",
          name: "Root Agent",
          model: "claude-test",
          usage,
          contextTokens: 100,
          lastTool: "Read",
          status: "active",
          depth: 0,
          toolUseId: null,
          children: [
            {
              id: "child",
              name: "Subagent",
              model: "claude-test",
              usage: subagentUsage,
              contextTokens: 50,
              lastTool: "Edit",
              status: "active",
              depth: 1,
              toolUseId: "tool",
              children: [
                {
                  id: "grandchild",
                  name: "Deep Subagent",
                  model: "claude-test",
                  usage,
                  contextTokens: 25,
                  lastTool: "Write",
                  status: "active",
                  depth: 2,
                  toolUseId: "nested-tool",
                  children: [],
                },
              ],
            },
          ],
        }
      : null,
  cost: null,
});

class IdleWebSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(_url: string) {}
  close() {}
}
let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe("Activity fleet lanes", () => {
  it("renders linked root and subagent lanes without controls or a transcript", async () => {
    vi.stubGlobal("WebSocket", IdleWebSocket);
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({ processes: [process("attempt"), process("chat")] }),
        ),
    );
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => {
      root?.render(
        createElement(ActivityView, {
          config: makeConfig({
            harnesses: {
              claude: {
                command: "claude",
                args: [],
                env: {},
                models: [
                  {
                    id: "claude-test",
                    price: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
                    contextWindow: 200,
                  },
                ],
                defaultModel: "claude-test",
                cacheWarmSeconds: 300,
              },
            },
          }),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain("Subagent");
    expect(host.textContent).toContain("Read");
    expect(host.textContent).toContain("Edit");
    expect(host.textContent).toContain("100 / 200 · 50%");
    expect(host.textContent).toContain("50 / 200 · 25%");
    expect(host.textContent).toContain("1M");
    expect(host.textContent).toContain("$2.00");
    expect(host.textContent).not.toContain("Deep Subagent");
    expect(host.querySelector('a[href="/task/4"]')).not.toBeNull();
    expect(host.querySelector('a[href="/?conversation=2"]')).not.toBeNull();
    expect(host.querySelectorAll('button[aria-label*="Expand"]')).toHaveLength(
      0,
    );
    expect(host.textContent).not.toMatch(
      /Stop|Grant|Deny|Resolve|Process tree/,
    );
  });
});
