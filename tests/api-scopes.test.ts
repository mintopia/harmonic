import { describe, it, expect } from 'vitest';
import { scopedKeyAllowed, readScopeAllowed } from '../src/server/app-auth-hook.js';

describe('scopedKeyAllowed', () => {
  it('allows /mcp regardless of the rest of the path', () => {
    expect(scopedKeyAllowed('/mcp')).toBe(true);
    expect(scopedKeyAllowed('/mcp/anything')).toBe(true);
  });

  it('blocks completing or steering an attempt', () => {
    expect(scopedKeyAllowed('/api/tasks/1/complete')).toBe(false);
    expect(scopedKeyAllowed('/api/tasks/42/steer')).toBe(false);
  });

  it('blocks the human-only accept/reject/close dispositions', () => {
    expect(scopedKeyAllowed('/api/tasks/1/accept')).toBe(false);
    expect(scopedKeyAllowed('/api/tasks/1/reject')).toBe(false);
    expect(scopedKeyAllowed('/api/tasks/1/close')).toBe(false);
  });

  it('blocks force-integrate and epic-reject on Epics', () => {
    expect(scopedKeyAllowed('/api/workspaces/1/epics/2/force-integrate')).toBe(false);
    expect(scopedKeyAllowed('/api/workspaces/1/epics/2/reject')).toBe(false);
  });

  it('blocks the Epic surface generally, listed or by id', () => {
    expect(scopedKeyAllowed('/api/workspaces/1/epics')).toBe(false);
    expect(scopedKeyAllowed('/api/workspaces/1/epics/2')).toBe(false);
  });

  it('blocks Task channels', () => {
    expect(scopedKeyAllowed('/api/tasks/1/channels')).toBe(false);
    expect(scopedKeyAllowed('/api/tasks/1/channels/5')).toBe(false);
  });

  it('allows the rest of the task and attempt surface', () => {
    expect(scopedKeyAllowed('/api/tasks')).toBe(true);
    expect(scopedKeyAllowed('/api/tasks/1')).toBe(true);
    expect(scopedKeyAllowed('/api/tasks/1/attempts')).toBe(true);
    expect(scopedKeyAllowed('/api/attempts')).toBe(true);
    expect(scopedKeyAllowed('/api/attempts/1')).toBe(true);
  });

  it('denies everything else, e.g. the operator surface', () => {
    expect(scopedKeyAllowed('/api/keys')).toBe(false);
    expect(scopedKeyAllowed('/api/config')).toBe(false);
    expect(scopedKeyAllowed('/api/channels')).toBe(false);
  });
});

describe('readScopeAllowed', () => {
  it('is GET-only, rejecting every other method even on an allowed path', () => {
    expect(readScopeAllowed('/api/tasks', 'GET')).toBe(true);
    expect(readScopeAllowed('/api/tasks', 'POST')).toBe(false);
    expect(readScopeAllowed('/api/tasks/1', 'PATCH')).toBe(false);
    expect(readScopeAllowed('/api/tasks/1', 'DELETE')).toBe(false);
  });

  it('allows the WebSocket handshake', () => {
    expect(readScopeAllowed('/api/ws', 'GET')).toBe(true);
  });

  it('blocks the Epic surface, listed or by id', () => {
    expect(readScopeAllowed('/api/workspaces/1/epics', 'GET')).toBe(false);
    expect(readScopeAllowed('/api/workspaces/1/epics/2', 'GET')).toBe(false);
  });

  it('blocks Task channels', () => {
    expect(readScopeAllowed('/api/tasks/1/channels', 'GET')).toBe(false);
    expect(readScopeAllowed('/api/tasks/1/channels/5', 'GET')).toBe(false);
  });

  it('allows GET on tasks, attempts, and maps', () => {
    expect(readScopeAllowed('/api/tasks', 'GET')).toBe(true);
    expect(readScopeAllowed('/api/tasks/1', 'GET')).toBe(true);
    expect(readScopeAllowed('/api/attempts', 'GET')).toBe(true);
    expect(readScopeAllowed('/api/attempts/1', 'GET')).toBe(true);
    expect(readScopeAllowed('/api/maps', 'GET')).toBe(true);
    expect(readScopeAllowed('/api/maps/1', 'GET')).toBe(true);
  });

  it('allows GET on activity, operations, and scheduled-jobs', () => {
    expect(readScopeAllowed('/api/activity', 'GET')).toBe(true);
    expect(readScopeAllowed('/api/operations', 'GET')).toBe(true);
    expect(readScopeAllowed('/api/scheduled-jobs', 'GET')).toBe(true);
  });

  it('denies everything else, e.g. the operator surface', () => {
    expect(readScopeAllowed('/api/keys', 'GET')).toBe(false);
    expect(readScopeAllowed('/api/config', 'GET')).toBe(false);
    expect(readScopeAllowed('/api/channels', 'GET')).toBe(false);
  });
});
