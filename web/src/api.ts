import type { AppConfig, Run, RunEvent, Task } from './types';

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, json?.error?.message ?? res.statusText);
  return json as T;
}

export const api = {
  config: () => request<AppConfig>('GET', '/api/config'),
  tasks: () => request<{ tasks: Task[] }>('GET', '/api/tasks'),
  createTask: (input: Partial<Task> & { prompt: string; state?: 'draft' | 'ready' }) =>
    request<Task>('POST', '/api/tasks', input),
  updateTask: (id: number, input: Partial<Task>) => request<Task>('PATCH', `/api/tasks/${id}`, input),
  promoteTask: (id: number) => request<Task>('POST', `/api/tasks/${id}/ready`),
  cancelTask: (id: number) => request<Task>('POST', `/api/tasks/${id}/cancel`),
  requeueTask: (id: number, feedback?: string) =>
    request<Task>('POST', `/api/tasks/${id}/requeue`, feedback ? { feedback } : {}),
  acceptTask: (id: number) => request<Task>('POST', `/api/tasks/${id}/accept`),
  rejectTask: (id: number, feedback?: string) =>
    request<Task>('POST', `/api/tasks/${id}/reject`, feedback ? { feedback } : {}),
  runTask: (id: number) => request<Run>('POST', `/api/tasks/${id}/run`),
  taskRuns: (id: number) => request<{ runs: Run[] }>('GET', `/api/tasks/${id}/runs`),
  run: (id: number) => request<Run>('GET', `/api/runs/${id}`),
  runEvents: (id: number) => request<{ events: RunEvent[] }>('GET', `/api/runs/${id}/events`),
};
