import { useEffect, useState } from 'react';
import type { Task } from '../types';
import { TASK_STATES } from '../types';

const select =
  'rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 focus:border-amber-500 focus:outline-none';

export function TableView({ onOpen }: { onOpen: (task: Task) => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [state, setState] = useState('');
  const [harness, setHarness] = useState('');
  const [priority, setPriority] = useState('');
  const [sortBy, setSortBy] = useState<'createdAt' | 'priority'>('createdAt');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    const params = new URLSearchParams();
    if (state) params.set('state', state);
    if (harness) params.set('harness', harness);
    if (priority) params.set('priority', priority);
    params.set('sortBy', sortBy);
    params.set('order', order);
    fetch(`/api/tasks?${params}`)
      .then((r) => r.json())
      .then((body: { tasks: Task[] }) => setTasks(body.tasks));
  }, [state, harness, priority, sortBy, order]);

  const sortHeader = (key: 'createdAt' | 'priority', label: string) => (
    <th
      className="cursor-pointer select-none py-2 hover:text-zinc-200"
      onClick={() => {
        if (sortBy === key) setOrder(order === 'asc' ? 'desc' : 'asc');
        else {
          setSortBy(key);
          setOrder('asc');
        }
      }}
    >
      {label} {sortBy === key ? (order === 'asc' ? '↑' : '↓') : ''}
    </th>
  );

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-3 flex gap-2">
        <select className={select} value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">All states</option>
          {TASK_STATES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select className={select} value={harness} onChange={(e) => setHarness(e.target.value)}>
          <option value="">All harnesses</option>
          {['claude', 'codex', 'copilot'].map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        <select className={select} value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="">All priorities</option>
          {['high', 'normal', 'low'].map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <span className="ml-auto self-center text-xs text-zinc-500">{tasks.length} tasks</span>
      </div>

      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wider text-zinc-500">
          <tr>
            <th className="py-2">#</th>
            <th>Prompt</th>
            <th>State</th>
            <th>Harness</th>
            <th>Model</th>
            {sortHeader('priority', 'Priority')}
            {sortHeader('createdAt', 'Created')}
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr
              key={task.id}
              className="cursor-pointer border-t border-zinc-800 hover:bg-zinc-900"
              onClick={() => onOpen(task)}
            >
              <td className="py-2 text-zinc-500">{task.id}</td>
              <td className="max-w-md truncate pr-4 text-zinc-200">{task.prompt}</td>
              <td>
                <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs">{task.state}</span>
              </td>
              <td className="text-zinc-400">{task.harness}</td>
              <td className="font-mono text-xs text-zinc-400">{task.model}</td>
              <td className="text-zinc-400">{task.priority}</td>
              <td className="text-xs text-zinc-500">{new Date(task.createdAt).toLocaleString()}</td>
            </tr>
          ))}
          {tasks.length === 0 && (
            <tr>
              <td colSpan={7} className="py-6 text-center text-zinc-600">
                No tasks match.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
