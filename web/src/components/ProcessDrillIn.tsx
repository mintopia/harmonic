import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { subscribe } from '../ws';
import type { ActivityProcess, RunEvent } from '../types';
import { chip, labelType } from '../ui';
import {
  findNode,
  flattenTree,
  frameEvents,
  trackNodeActivity,
  NO_NODE_ACTIVITY,
  type NodeActivityMap,
} from '../process-tree-model';
import { EventStream } from './EventStream';
import { ProcessTree } from './ProcessTree';

/**
 * The expanded drill-in for one Activity Run (issue #53): its Process Tree on
 * the left, the selected node's live transcript on the right. Selecting a node
 * reframes the shared `EventStream` on that agent/session — not the whole Task —
 * via `frameEvents`. The output is sourced exactly the way the Task detail's
 * Output tab is (replay `GET /api/runs/:id/events`, then append live
 * `run_event`s), so the pane streams live while the operator watches.
 *
 * The idle lifecycle lives in the pure model: every tree snapshot (the 5s poll
 * and the `run_usage` firehose deltas the view already merges) is folded into a
 * `NodeActivityMap`, and the `now` tick ages each node active → inactive →
 * hidden between snapshots. Only Runs reach here — a Conversation has no tree.
 */
export function ProcessDrillIn({ process, now }: { process: ActivityProcess; now: number }) {
  const tree = process.tree!; // caller only mounts this for a Run with a tree
  const runId = process.runId;
  const [activity, setActivity] = useState<NodeActivityMap>(NO_NODE_ACTIVITY);
  const [selectedId, setSelectedId] = useState(tree.id);
  const [events, setEvents] = useState<RunEvent[]>([]);

  // Age off `now` (the prop), but stamp writes at the moment a snapshot lands —
  // so re-tracking only happens when the tree object actually changes, not once
  // a second. A ref carries the live `now` into that tree-triggered effect.
  const nowRef = useRef(now);
  nowRef.current = now;
  useEffect(() => {
    setActivity((prev) => trackNodeActivity(prev, tree, nowRef.current));
  }, [tree]);

  // Replay the persisted stream, then append live events — one representation
  // for both, same as the Task detail Output tab.
  useEffect(() => {
    if (runId === null) return;
    let live = true;
    setEvents([]);
    api.runEvents(runId).then(({ events }) => live && setEvents(events));
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'run_event' && msg.event.runId === runId) {
        setEvents((current) => (current.some((e) => e.id === msg.event.id) ? current : [...current, msg.event]));
      }
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [runId]);

  const rows = flattenTree(tree, activity, now);
  // A selection that aged out of the visible rows falls back to the root, so the
  // output pane never frames on a node that just disappeared from the tree.
  const selectedVisible = rows.some((r) => r.node.id === selectedId);
  const selected = (selectedVisible ? findNode(tree, selectedId) : undefined) ?? tree;
  const framed = frameEvents(events, selected);

  return (
    <div className="grid gap-4 border-t border-hairline bg-raised/20 px-4 py-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      {/* The tree: one selectable row per node, live status fading as it idles. */}
      <div className="min-w-0">
        <div className={`${labelType} mb-2 text-muted`}>Process tree</div>
        <ProcessTree tree={tree} activity={activity} now={now} selectedId={selected.id} onSelect={setSelectedId} />
      </div>

      {/* The output pane, framed on the selected node. */}
      <div className="min-w-0">
        <div className="mb-2 flex items-center gap-2">
          <span className={`${labelType} text-muted`}>Output</span>
          <span className="truncate font-medium text-ink" title={selected.name}>
            {selected.depth === 0 ? 'root session' : selected.name}
          </span>
          <span className={`${chip} shrink-0 bg-raised text-muted`}>{selected.model}</span>
        </div>
        <div className="max-h-96 overflow-y-auto rounded-md bg-surface p-3">
          {framed.length > 0 ? (
            <EventStream events={framed} />
          ) : (
            <p className="text-small text-muted">
              {selected.depth === 0
                ? 'No output yet.'
                : // A Subagent only streams here when the harness tags its tool
                  // activity onto the parent session (Claude Code). Deeper spawns
                  // — and harnesses that don't tag — keep their transcript in
                  // their own log, rolled up under the root rather than shown here.
                  'This Subagent’s transcript rolls up under the root session — it doesn’t stream separately here.'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
