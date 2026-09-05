import { useEffect, useState } from "react";
import { formatCost } from "../cost";
import type { ActivityProcess, AppConfig, ProcessNode } from "../types";
import { subscribe } from "../ws";
import {
  card,
  chip,
  displayTitle,
  labelType,
  selectField,
  touchTarget,
} from "../ui";
import { EmptyState } from "./EmptyState";
import {
  activitySummary,
  activityWorkspaces,
  filterActivity,
  fleetLanes,
  mergeRunUsage,
  resolveActivityFilter,
  usageTotalTokens,
  ACTIVITY_TYPE_FILTERS,
  HIGH_LOAD_FILL,
  NO_ACTIVITY_FILTER,
  type ActivityFilter,
  type ActivityTypeFilter,
} from "../activity-model";
import {
  computeContextUsage,
  formatContextUsage,
} from "../conversation-telemetry-model";
import { issueRef } from "../id-format.js";
import { useLiveEffect } from "../useLiveEffect";

const compact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const TYPE_FILTER_LABELS: Record<ActivityTypeFilter, string> = {
  all: "All",
  attempts: "Attempts",
  chats: "Conversations",
};

function TypeSegments({
  value,
  onChange,
}: {
  value: ActivityTypeFilter;
  onChange: (value: ActivityTypeFilter) => void;
}) {
  return (
    <div
      className="flex gap-0.5 rounded-md bg-raised p-0.5"
      role="group"
      aria-label="Filter by type"
    >
      {ACTIVITY_TYPE_FILTERS.map((type) => (
        <button
          key={type}
          aria-pressed={type === value}
          onClick={() => onChange(type)}
          className={`${touchTarget} rounded-sm px-2.5 text-small transition-colors duration-150 ${type === value ? "bg-surface font-semibold text-ink shadow-card" : "font-medium text-muted hover:text-ink"}`}
        >
          {TYPE_FILTER_LABELS[type]}
        </button>
      ))}
    </div>
  );
}

function Empty() {
  return <span className="text-muted">—</span>;
}

function modelEntryFor(
  node: ProcessNode,
  process: ActivityProcess,
  config: AppConfig | null,
) {
  const models = config?.harnesses[process.harness]?.models;
  const baseModel = node.model.replace(/-\d{8}$/, "");
  return (
    models?.find((model) => model.id === node.model) ??
    models?.find((model) => model.id === baseModel)
  );
}

function contextWindowFor(
  node: ProcessNode | null,
  process: ActivityProcess,
  config: AppConfig | null,
): number | null {
  if (!node) return process.contextWindow;
  const window = modelEntryFor(node, process, config)?.contextWindow;
  if (window !== undefined) return window;
  return node.model === process.model ? process.contextWindow : null;
}

function costForNode(
  node: ProcessNode,
  process: ActivityProcess,
  config: AppConfig | null,
): string | null {
  const price = modelEntryFor(node, process, config)?.price;
  if (!price)
    return formatCost({
      totalUsd: null,
      byModel: { [node.model]: null },
      incomplete: true,
    });
  const usage = node.usage;
  const totalUsd =
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite) /
    1_000_000;
  return formatCost({
    totalUsd,
    byModel: { [node.model]: totalUsd },
    incomplete: false,
  });
}

function ContextMeter({
  process,
  node,
  config,
}: {
  process: ActivityProcess;
  node: ProcessNode | null;
  config: AppConfig | null;
}) {
  const tokens = node?.contextTokens ?? process.contextTokens;
  const window = contextWindowFor(node, process, config);
  const fill = tokens === null || window === null ? null : tokens / window;
  const { value, note } = formatContextUsage(
    computeContextUsage({ contextTokens: tokens, contextWindow: window }),
  );
  const meterValue =
    tokens === null || window === null || fill === null
      ? value
      : `${compact.format(tokens)} / ${compact.format(window)} · ${Math.round(fill * 100)}%`;
  const tone =
    fill !== null && fill >= 1
      ? "bg-fail"
      : fill !== null && fill >= HIGH_LOAD_FILL
        ? "bg-running"
        : "bg-accent";
  return (
    <div className="min-w-[14rem]">
      <div className="mb-1 flex items-baseline gap-1.5 text-small text-ink">
        <span className="sr-only">Context: </span>
        <span className="tabular-nums">{meterValue}</span>
        {note && <span className="text-muted">{note}</span>}
      </div>
      <div
        aria-hidden="true"
        className="h-2 overflow-hidden rounded-full bg-raised"
      >
        {fill !== null && (
          <div
            className={`h-full w-full origin-left rounded-full ${tone}`}
            style={{ transform: `scaleX(${Math.min(1, fill)})` }}
          />
        )}
      </div>
    </div>
  );
}

function Lane({
  process,
  node,
  depth,
  config,
}: {
  process: ActivityProcess;
  node: ProcessNode | null;
  depth: number;
  config: AppConfig | null;
}) {
  const isRoot = depth === 0;
  const tokens = node
    ? node.usage.inputTokens +
      node.usage.outputTokens +
      node.usage.cacheReadTokens +
      node.usage.cacheWriteTokens
    : usageTotalTokens(process.usage);
  const href =
    process.type === "attempt"
      ? `/task/${process.taskId}`
      : `/?conversation=${process.conversationId}`;
  const name = node?.name ?? process.title;
  const model = node?.model ?? process.model;
  const cost = node
    ? costForNode(node, process, config)
    : formatCost(process.cost);
  const active =
    node?.status === "active" || (node === null && process.type === "chat");
  return (
    <a
      href={href}
      aria-label={`Open ${isRoot ? name : `${name}, subagent`}`}
      className="grid min-h-14 grid-cols-[minmax(12rem,1fr)_minmax(14rem,1.4fr)_5.5rem_5rem_minmax(6rem,0.7fr)] items-center gap-4 border-t border-hairline px-4 py-3 text-small transition-colors duration-150 hover:bg-raised"
      style={{ paddingLeft: `${16 + depth * 24}px` }}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`size-[7px] shrink-0 rounded-full ${active ? "bg-running-dot motion-safe:animate-pulse" : "bg-faint"}`}
          />
          <span className="truncate font-semibold text-ink" title={name}>
            {name}
          </span>
          {isRoot &&
            (process.type === "chat" ? (
              <span className={`${chip} bg-raised text-muted`}>Chat</span>
            ) : (
              process.trackerRef !== null && (
                <span className="text-muted">
                  {issueRef(process.trackerRef)}
                </span>
              )
            ))}
        </div>
        <div className="mt-1 truncate text-small text-muted">{model}</div>
      </div>
      <ContextMeter process={process} node={node} config={config} />
      <div className="text-right tabular-nums text-ink">
        {tokens === null ? <Empty /> : compact.format(tokens)}
      </div>
      <div className="text-right tabular-nums text-ink">
        {cost ?? <Empty />}
      </div>
      <div
        className="truncate text-right text-muted"
        title={node?.lastTool ?? undefined}
      >
        {node?.lastTool ?? <Empty />}
      </div>
    </a>
  );
}

function Stat({
  label,
  value,
  tone = "text-ink",
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div>
      <div className={`${labelType} mb-1 text-muted`}>{label}</div>
      <div className={`text-title font-semibold tabular-nums ${tone}`}>
        {value}
      </div>
    </div>
  );
}

export function ActivityView({ config }: { config: AppConfig | null }) {
  const [processes, setProcesses] = useState<ActivityProcess[] | null>(null);
  const [filter, setFilter] = useState<ActivityFilter>(NO_ACTIVITY_FILTER);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  useLiveEffect((live) => {
    const load = () =>
      fetch("/api/activity")
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { processes: ActivityProcess[] } | null) => {
          if (live() && body) setProcesses(body.processes);
        })
        .catch(() => {});
    load();
    const poll = setInterval(load, 5_000);
    const unsubscribe = subscribe((message) => {
      if (message.type === "attempt_usage")
        setProcesses((current) =>
          current ? mergeRunUsage(current, message) : current,
        );
      else if (
        message.type === "attempt_changed" &&
        message.run.state !== "running"
      )
        setProcesses(
          (current) =>
            current?.filter(
              (process) =>
                !(
                  process.type === "attempt" &&
                  process.attemptId === message.run.id
                ),
            ) ?? current,
        );
      else if (
        message.type === "conversation_changed" &&
        message.conversation.state === "ended"
      )
        setProcesses(
          (current) =>
            current?.filter(
              (process) =>
                !(
                  process.type === "chat" &&
                  process.conversationId === message.conversation.id
                ),
            ) ?? current,
        );
    }, load);
    return () => {
      clearInterval(poll);
      unsubscribe();
    };
  }, []);
  if (processes === null)
    return (
      <div>
        <h1 className={`${displayTitle} mb-5`}>Activity</h1>
        <div className={`${card} p-4`}>
          <div className="h-14 animate-pulse motion-reduce:animate-none" />
        </div>
      </div>
    );

  const ceiling =
    config?.autoRunner.maxConcurrentAttempts ??
    Math.max(
      processes.filter((process) => process.type === "attempt").length,
      1,
    );
  const summary = activitySummary(processes, ceiling, now);
  const workspaces = activityWorkspaces(processes);
  const activeFilter = resolveActivityFilter(filter, workspaces);
  const lanes = fleetLanes(filterActivity(processes, activeFilter));
  return (
    <div>
      <div className="mb-5 flex items-baseline gap-3">
        <h1 className={displayTitle}>Activity</h1>
        <span className={`${labelType} text-muted`}>
          every live Agent, all Workspaces
        </span>
      </div>
      <div className={`${card} mb-5 flex flex-wrap gap-x-10 gap-y-4 p-5`}>
        <Stat label="Agents" value={String(summary.agentCount)} />
        <Stat label="Subagents" value={String(summary.subagentCount)} />
        <Stat
          label="Cost"
          value={formatCost(summary.cost) ?? "—"}
          tone={summary.cost ? "text-ink" : "text-muted"}
        />
        <Stat
          label="Fleet tok/s"
          value={compact.format(Math.round(summary.tokensPerSecond))}
        />
        <Stat
          label="Host ceiling"
          value={`${summary.ceiling.running}/${summary.ceiling.max}`}
          tone={
            summary.ceiling.running >= summary.ceiling.max
              ? "text-running"
              : "text-ink"
          }
        />
      </div>
      {processes.length === 0 ? (
        <EmptyState title="Nothing running">
          No Attempts or Conversations are in flight right now.
        </EmptyState>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <TypeSegments
              value={filter.type}
              onChange={(type) =>
                setFilter((current) => ({ ...current, type }))
              }
            />
            {workspaces.length > 1 && (
              <select
                aria-label="Filter by workspace"
                className={selectField}
                value={activeFilter.workspaceId ?? ""}
                onChange={(event) =>
                  setFilter((current) => ({
                    ...current,
                    workspaceId:
                      event.target.value === ""
                        ? null
                        : Number(event.target.value),
                  }))
                }
              >
                <option value="">All workspaces</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            )}
            <div className="flex-1" />
            <span className={`${labelType} text-muted`}>
              {lanes.length} {lanes.length === 1 ? "lane" : "lanes"}
            </span>
          </div>
          {lanes.length === 0 ? (
            <EmptyState title="Nothing matches">
              Widen the type or Workspace to see the rest of the fleet.
            </EmptyState>
          ) : (
            <div
              className={`${card} overflow-x-auto`}
              aria-label="Live Agent lanes"
            >
              <div className="grid grid-cols-[minmax(12rem,1fr)_minmax(14rem,1.4fr)_5.5rem_5rem_minmax(6rem,0.7fr)] gap-4 px-4 py-2.5 text-label text-muted">
                <span>Agent</span>
                <span>Context</span>
                <span className="text-right">Tokens</span>
                <span className="text-right">Cost</span>
                <span className="text-right">Last tool</span>
              </div>
              {lanes.map((lane) => (
                <Lane
                  key={`${lane.process.type}-${lane.process.attemptId ?? lane.process.conversationId}-${lane.node?.id ?? "root"}`}
                  {...lane}
                  config={config}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
