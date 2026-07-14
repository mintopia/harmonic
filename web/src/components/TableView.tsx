import { useEffect, useState } from 'react';
import { formatCost } from '../cost';
import type { Task } from '../types';
import { TASK_STATES } from '../types';

const select =
  'rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 focus:border-amber-500 focus:outline-none';

type SortKey = 'createdAt' | 'priority' | 'cost';

export function TableView({ onOpen }: { onOpen: (task: Task) => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState('');
  const [harness, setHarness] = useState('');
  const [priority, setPriority] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('createdAt');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    const params = new URLSearchParams();
    if (state) params.set('state', state);
    if (harness) params.set('harness', harness);
    if (priority) params.set('priority', priority);
    params.set('sortBy', sortBy);
    params.set('order', order);
    setLoading(true);
    fetch(`/api/tasks?${params}`)
      .then((r) => r.json())
      .then((body: { tasks: Task[] }) => {
        setTasks(body.tasks);
        setLoading(false);
      });
  }, [state, harness, priority, sortBy, order]);

  const sortHeader = (key: SortKey, label: string, align?: 'right') => (
    <th
      aria-sort={sortBy === key ? (order === 'asc' ? 'ascending' : 'descending') : undefined}
      className={`py-2 ${align === 'right' ? 'text-right' : ''}`}
    >
      <button
        type="button"
        className="cursor-pointer select-none hover:text-zinc-200"
        onClick={() => {
          if (sortBy === key) setOrder(order === 'asc' ? 'desc' : 'asc');
          else {
            setSortBy(key);
            setOrder('asc');
          }
        }}
      >
        {label} {sortBy === key ? (order === 'asc' ? '↑' : '↓') : ''}
      </button>
    </th>
  );

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-3 flex flex-wrap gap-2">
        <select aria-label="Filter by state" className={select} value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">All states</option>
          {TASK_STATES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select aria-label="Filter by harness" className={select} value={harness} onChange={(e) => setHarness(e.target.value)}>
          <option value="">All harnesses</option>
          {['claude', 'codex', 'copilot'].map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        <select aria-label="Filter by priority" className={select} value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="">All priorities</option>
          {['high', 'normal', 'low'].map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <span className="ml-auto self-center text-xs tabular-nums text-zinc-400">
          {loading ? 'Loading…' : `${tasks.length} tasks`}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wider text-zinc-400">
            <tr>
              <th className="py-2">#</th>
              <th>Prompt</th>
              <th>State</th>
              <th>Harness</th>
              <th>Model</th>
              {sortHeader('priority', 'Priority')}
              {sortHeader('cost', 'Cost', 'right')}
              {sortHeader('createdAt', 'Created')}
            </tr>
          </thead>
          {/* Stale rows stay visible while a refetch is in flight, dimmed so the
              "Loading…" count isn't the only signal. */}
          <tbody className={loading ? 'opacity-60' : ''}>
            {tasks.map((task) => (
              <tr
                key={task.id}
                className="cursor-pointer border-t border-zinc-800 hover:bg-zinc-900"
                onClick={() => onOpen(task)}
              >
                <td className="py-2 tabular-nums text-zinc-400">{task.id}</td>
                <td className="max-w-md pr-4">
                  <button
                    type="button"
                    className="block w-full cursor-pointer truncate text-left text-zinc-200"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(task);
                    }}
                  >
                    {task.prompt}
                  </button>
                </td>
                <td>
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs">{task.state}</span>
                </td>
                <td className="text-zinc-400">{task.harness}</td>
                <td className="font-mono text-xs text-zinc-400">{task.model}</td>
                <td className="text-zinc-400">{task.priority}</td>
                <td className="text-right text-xs tabular-nums text-zinc-400">{formatCost(task.cost) ?? '—'}</td>
                <td className="text-xs tabular-nums text-zinc-400">{new Date(task.createdAt).toLocaleString()}</td>
              </tr>
            ))}
            {!loading && tasks.length === 0 && (
              <tr>
                <td colSpan={8} className="py-6 text-center text-zinc-400">
                  No tasks match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
