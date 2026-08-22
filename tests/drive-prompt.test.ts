import { describe, expect, it } from 'vitest';
import { buildDrivePrompt } from '../src/execution/prompt-template.js';
import { driveFields, skillFor, splitTitleBody } from '../src/execution/drive-prompt.js';
import type { TaskRow } from '../src/db/schema.js';

const task = (over: Partial<TaskRow>): TaskRow =>
  ({ prompt: 'Title\n\nBody', harness: 'claude', wayfinderType: 'task', trackerRef: 42, ...over }) as TaskRow;

describe('buildDrivePrompt (prompt-template.ts)', () => {
  it('fills every token and leaves none behind', () => {
    const out = buildDrivePrompt('{skill} {ref} {url} {title} — {body}', {
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
});
