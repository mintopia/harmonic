import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { ActivityProcess, ProcessNode, AttemptLogEvent } from '../types';
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
import { useLiveEffect } from '../useLiveEffect';

/** An Activity process the caller has confirmed carries a Process Tree. */
export type RunWithTree = ActivityProcess & { tree: ProcessNode };

/** True when the process carries a Process Tree — narrows to {@link RunWithTree}. */
export function hasProcessTree(p: ActivityProcess): p is RunWithTree {
  return p.tree !== null;
}

export function ProcessDrillIn({ process, now }: { process: RunWithTree; now: number }) {
  const tree = process.tree;
  const attemptId = process.attemptId;
  const [activity, setActivity] = useState<NodeActivityMap>(NO_NODE_ACTIVITY);
  const [selectedId, setSelectedId] = useState(tree.id);
  const [events, setEvents] = useState<AttemptLogEvent[]>([]);
  const [logUnavailable, setLogUnavailable] = useState(false);

  const nowRef = useRef(now);
  // eslint-disable-next-line react/refs -- deliberately synced during render so the tree-triggered effect reads the live `now` without depending on it
  nowRef.current = now;
  useEffect(() => {
    setActivity((prev) => trackNodeActivity(prev, tree, nowRef.current));
  }, [tree]);

  useLiveEffect((live) => {
    if (attemptId === null) return;
    setEvents([]);
    setLogUnavailable(false);
    const load = () =>
      api.attemptLog(attemptId).then((log) => {
        if (!live()) return;
        setLogUnavailable(log.status === 'unavailable');
        setEvents(log.status === 'available' ? log.events : []);
      });
    load();
    const interval = window.setInterval(load, 1_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [attemptId]);

  const rows = flattenTree(tree, activity, now);
  const selectedVisible = rows.some((r) => r.node.id === selectedId);
  const selected = (selectedVisible ? findNode(tree, selectedId) : undefined) ?? tree;
  const framed = frameEvents(events, selected);

  return (
    <div className="grid gap-4 border-t border-hairline bg-raised/20 px-4 py-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <div className="min-w-0">
        <div className={`${labelType} mb-2 text-muted`}>Process tree</div>
        <ProcessTree tree={tree} activity={activity} now={now} selectedId={selected.id} onSelect={setSelectedId} />
      </div>

      <div className="min-w-0">
        <div className="mb-2 flex items-center gap-2">
          <span className={`${labelType} text-muted`}>Output</span>
          <span className="truncate font-medium text-ink" title={selected.name}>
            {selected.depth === 0 ? 'root session' : selected.name}
          </span>
          <span className={`${chip} shrink-0 bg-raised text-muted`}>{selected.model}</span>
        </div>
        <div className="max-h-96 overflow-y-auto rounded-md bg-surface p-3">
          {logUnavailable ? (
            <p className="text-small text-muted">Log unavailable.</p>
          ) : framed.length > 0 ? (
            <EventStream events={framed} />
          ) : (
            <p className="text-small text-muted">
              {selected.depth === 0
                ? 'No output yet.'
                :
                  'This Subagent’s transcript rolls up under the root session — it doesn’t stream separately here.'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
