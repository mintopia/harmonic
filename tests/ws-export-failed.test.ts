// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { parseServerMessage } from '../web/src/ws.js';

const wire = { type: 'export_failed', trackerRef: null, destination: 's3', disposition: 'done', error: 'boom', retry: 0, nextRetryAt: null } as const;

describe('parseServerMessage export_failed', () => {
  it('parses a Task owner', () => {
    const parsed = parseServerMessage({ ...wire, taskId: 7, epicRef: null, workspaceId: 1 });
    expect(parsed).toMatchObject({ type: 'export_failed', owner: { kind: 'task', taskId: 7 } });
    expect(parsed).not.toHaveProperty('taskId');
  });

  it('parses an Epic owner with its workspace', () => {
    expect(parseServerMessage({ ...wire, taskId: null, epicRef: '42', workspaceId: 3 })).toMatchObject({ owner: { kind: 'epic', epicRef: '42', workspaceId: 3 } });
  });

  it('drops a payload with no owner', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseServerMessage({ ...wire, taskId: null, epicRef: null, workspaceId: 1 })).toBeNull();
    expect(parseServerMessage({ ...wire, taskId: null, epicRef: '42', workspaceId: null })).toBeNull();
    warn.mockRestore();
  });

  it('passes other messages through', () => {
    const msg = { type: 'task_removed', id: 1 } as const;
    expect(parseServerMessage(msg)).toBe(msg);
  });
});
