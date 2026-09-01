import { describe, expect, it } from 'vitest';
import { driveFields, fillTemplate, skillFor, splitTitleBody } from '../src/execution/prompt-template.js';
import type { TaskRow } from '../src/db/schema.js';

const task = (over: Partial<TaskRow> & { epicKind?: string | null }): TaskRow & { epicKind?: string | null } =>
  ({ prompt: 'Title\n\nBody', harness: 'claude', wayfinderType: 'task', trackerRef: 42, mapRef: null, ...over }) as TaskRow & {
    epicKind?: string | null;
  };

describe('fillTemplate (prompt-template.ts)', () => {
  it('fills every token and leaves none behind', () => {
    const out = fillTemplate('{skill} {ref} {url} {title} — {body}', {
      skill: '/implement',
      ref: '42',
      url: 'http://x/42',
      title: 'T',
      body: 'B',
    });
    expect(out).toBe('/implement 42 http://x/42 T — B');
    expect(out).not.toMatch(/\{/);
  });
});

describe('skillFor', () => {
  it('prefixes with / for non-codex and $ for codex', () => {
    expect(skillFor(task({ harness: 'claude', wayfinderType: 'task' }))).toBe('/implement');
    expect(skillFor(task({ harness: 'codex', wayfinderType: 'task' }))).toBe('$implement');
  });
  it('maps research to the research skill, everything else to implement', () => {
    expect(skillFor(task({ wayfinderType: 'research' }))).toBe('/research');
    expect(skillFor(task({ wayfinderType: 'grilling' }))).toBe('/implement');
  });
  it('routes a Map-Epic child to the wayfinder skill, taking precedence over wayfinderType', () => {
    expect(skillFor({ wayfinderType: null, harness: 'claude', epicKind: 'map' })).toBe('/wayfinder');
    expect(skillFor({ wayfinderType: null, harness: 'codex', epicKind: 'map' })).toBe('$wayfinder');
    // A Spec/plain-Epic child is unchanged; a null kind is not a Map.
    expect(skillFor({ wayfinderType: null, harness: 'claude', epicKind: 'spec' })).toBe('/implement');
    // Map kind wins even when the child itself carries a research wayfinder label.
    expect(skillFor({ wayfinderType: 'research', harness: 'claude', epicKind: 'map' })).toBe('/wayfinder');
  });
});

describe('splitTitleBody', () => {
  it('splits on the first blank line', () => {
    expect(splitTitleBody('Title\n\nBody text')).toEqual({ title: 'Title', body: 'Body text' });
  });
  it('treats a promptless-body as title only', () => {
    expect(splitTitleBody('Just a title')).toEqual({ title: 'Just a title', body: '' });
  });
});

describe('driveFields', () => {
  it('sources the five tokens from the task and the url resolver', () => {
    const fields = driveFields(task({ prompt: 'Fix it\n\nDetails', trackerRef: 7 }), () => 'http://tracker/7');
    expect(fields).toEqual({ skill: '/implement', ref: '7', url: 'http://tracker/7', title: 'Fix it', body: 'Details' });
  });
  it('falls back to empty ref/url when absent', () => {
    const fields = driveFields(task({ trackerRef: null }), () => null);
    expect(fields.ref).toBe('');
    expect(fields.url).toBe('');
  });
  it('points a Map-Epic child at the map ref/url, not its own ticket', () => {
    const child = task({ trackerRef: 7, mapRef: 100, epicKind: 'map', prompt: 'Chart it\n\nwhy' });
    const fields = driveFields(child, (t) => `http://tracker/${t.trackerRef}`);
    expect(fields).toEqual({ skill: '/wayfinder', ref: '100', url: 'http://tracker/100', title: 'Chart it', body: 'why' });
  });
});
