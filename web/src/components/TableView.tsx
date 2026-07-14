import { useEffect, useState } from 'react';
import { formatCost } from '../cost';
import type { Task } from '../types';
import { TASK_STATES } from '../types';
import { labelType, stateChip } from '../ui';

const select =
  'rounded-md border border-hairline bg-canvas px-2 py-1 text-label text-ink focus:border-accent focus:outline-none';

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

  const sortHeader = (key: SortKey, label: string, align?: 'right', extra = '') => (
    <th
      aria-sort={sortBy === key ? (order === 'asc' ? 'ascending' : 'descending') : undefined}
      className={`py-2 ${align === 'right' ? 'text-right' : ''} ${extra}`}
    >
      <button
        type="button"
        className="cursor-pointer select-none hover:text-ink"
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
    <div>
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
        <span className="ml-auto self-center text-muted">
          {loading ? 'Loading…' : `${tasks.length} tasks`}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead className={`${labelType} text-muted`}>
            <tr>
              <th className="py-2">#</th>
              <th>Prompt</th>
              <th>State</th>
              <th>Harness</th>
              <th>Model</th>
              {sortHeader('priority', 'Priority')}
              {sortHeader('cost', 'Cost', 'right')}
              {sortHeader('createdAt', 'Created', undefined, 'pl-4')}
            </tr>
          </thead>
          {/* Stale rows stay visible while a refetch is in flight, dimmed so the
              "Loading…" count isn't the only signal. */}
          <tbody className={loading ? 'opacity-60' : ''}>
            {tasks.map((task) => (
              <tr
                key={task.id}
                className="cursor-pointer border-t border-hairline hover:bg-surface"
                onClick={() => onOpen(task)}
              >
                <td className="py-2 font-data text-data text-muted">{task.id}</td>
                <td className="max-w-md pr-4">
                  <button
                    type="button"
                    className="block w-full cursor-pointer truncate text-left text-ink"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(task);
                    }}
                  >
                    {task.prompt}
                  </button>
                </td>
                <td>
                  <span className={stateChip(task.state)}>{task.state}</span>
                </td>
                <td className="text-muted">{task.harness}</td>
                <td className="font-data text-data text-muted">{task.model}</td>
                <td className={task.priority === 'high' ? 'font-semibold text-ink' : 'text-muted'}>{task.priority}</td>
                <td className="text-right font-data text-data text-muted">{formatCost(task.cost) ?? '—'}</td>
                <td className="pl-4 font-data text-data text-muted">{new Date(task.createdAt).toLocaleString()}</td>
              </tr>
            ))}
            {!loading && tasks.length === 0 && (
              <tr>
                <td colSpan={8} className="py-6 text-center text-muted">
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
