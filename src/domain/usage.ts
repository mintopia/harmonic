export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * Harness-native spend units for this model's calls (Copilot AI Units,
   * CONTEXT.md) — actual spend shown alongside Cost, never folded into it
   * (decision Q4). Absent when the harness has none; never a fake zero.
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
   * Per-agent-type breakdown (agent-usage / subagent-share stats): each
   * Process Tree node's own tokens folded under its name (`root` for the
   * root session, the agentType for a Subagent). Absent for harnesses/runs
   * with no parsed tree, and on runs recorded before the field existed —
   * the Stats aggregation treats a missing map as "no per-agent data".
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
  /** Tool-call tallies from the Run's aggregate store. */
  toolCalls: Record<string, number>;
  /** The run's context-window occupancy in tokens at the time this usage was
   * recorded; absent on runs/harnesses that don't report it. The live gauge
   * prefers the attempt_usage snapshot; this is the persisted fallback (issue #52). */
  contextTokens?: number | null;
  source: 'acp' | 'session-log' | 'combined' | null;
}
