export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * Harness-native spend units for this model's calls (Copilot AI Units) —
   * actual spend shown alongside Cost, never folded into it. Absent when the
   * harness has none; never a fake zero.
   */
  aiUnits?: number;
}

/** Output token/cost attribution for one tool or the no-tool reasoning bucket. */
export interface ToolTokenUsage {
  outputTokens: number;
  /** API-equivalent output cost. Absent for an unpriced model, never zeroed. */
  cost?: number;
}

export interface AttemptUsage {
  /** Per-model breakdown (session-log fallback; ACP only reports aggregates). */
  models: Record<string, ModelUsage>;
  /**
   * Per-agent-type breakdown: each Process Tree node's own tokens folded under
   * its name (`root` for the root session, the agentType for a Subagent).
   * Absent when no tree was parsed.
   */
  agents?: Record<string, ModelUsage>;
  /** Output tokens and API-equivalent cost attributed to tools, when the
   * harness transcript exposes per-turn tool calls. */
  toolTokens?: Record<string, ToolTokenUsage>;
  /** Output from parsed turns that called no tool. Absent with `toolTokens`
   * when a harness cannot expose per-turn attribution. */
  reasoning?: ToolTokenUsage;
  /** Aggregate token counts; null when no source reported tokens. */
  totals: (ModelUsage & { totalTokens: number | null }) | null;
  /** Tool-call tallies from the Attempt's aggregate store. */
  toolCalls: Record<string, number>;
  /** The Attempt's context-window occupancy in tokens when this usage was
   * recorded; absent when the harness doesn't report it. */
  contextTokens?: number | null;
  source: 'acp' | 'session-log' | 'combined' | null;
}
