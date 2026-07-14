import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HarnessAdapter, ModelUsage } from './adapter.js';

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

export const claudeAdapter: HarnessAdapter = {
  spawnEnv: (model) => ({
    // The adapter refuses to start nested inside a Claude Code session
    // (spike finding); AgentDeck itself may have been launched from one.
    CLAUDECODE: undefined,
    CLAUDE_CODE_ENTRYPOINT: undefined,
    ANTHROPIC_MODEL: model,
  }),

  // Claude agents reach AgentDeck's MCP server via the env-var mechanism.
  mcpServers: () => [],

  usage: {
    /**
     * Claude Code writes `<sessionLogDir>/<slug(cwd)>/<sessionId>.jsonl`
     * where the slug replaces every non-alphanumeric character with '-',
     * and the ACP sessionId equals the log filename (spike finding).
     */
    sessionLogFile({ sessionLogDir, cwd, sessionId }) {
      const logDir = sessionLogDir ?? join(homedir(), '.claude', 'projects');
      if (!logDir || !sessionId) return null;
      const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
      return join(logDir, slug, `${sessionId}.jsonl`);
    },

    /**
     * Each assistant message line carries `message.model` + `message.usage`;
     * chunked messages repeat the same message id, so dedupe on it.
     */
    modelsFromSessionLog(file) {
      if (!existsSync(file)) return {};

      const models: Record<string, ModelUsage> = {};
      const seen = new Set<string>();
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let entry: any;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const message = entry?.message;
        if (entry?.type !== 'assistant' || !message?.model || !message?.usage) continue;
        const key = typeof message.id === 'string' ? message.id : line;
        if (seen.has(key)) continue;
        seen.add(key);
        const bucket = (models[message.model] ??= {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
        bucket.inputTokens += num(message.usage.input_tokens);
        bucket.outputTokens += num(message.usage.output_tokens);
        bucket.cacheReadTokens += num(message.usage.cache_read_input_tokens);
        bucket.cacheWriteTokens += num(message.usage.cache_creation_input_tokens);
      }
      return models;
    },

    toolName(payload) {
      const name = (payload as any)?._meta?.claudeCode?.toolName;
      return typeof name === 'string' ? name : null;
    },
  },
};
