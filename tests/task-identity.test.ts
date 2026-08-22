import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskIdentity, formatModelLabel } from '../web/src/components/TaskIdentity.js';

const TABLE_VIEW = readFileSync(
  fileURLToPath(new URL('../web/src/components/TableView.tsx', import.meta.url)),
  'utf8',
);

const DECK = readFileSync(
  fileURLToPath(new URL('../web/src/components/Deck.tsx', import.meta.url)),
  'utf8',
);

describe('formatModelLabel', () => {
  it('drops the provider prefix from the task model label', () => {
    expect(formatModelLabel('claude-sonnet-4-6')).toBe('sonnet-4-6');
    expect(formatModelLabel('gpt-5.3-codex')).toBe('5.3-codex');
    expect(formatModelLabel('gpt-5-mini')).toBe('5-mini');
  });

  it('leaves unknown model shapes alone', () => {
    expect(formatModelLabel('stub-model')).toBe('stub-model');
  });
});

describe('TaskIdentity', () => {
  it('shows the shortened model but preserves the full model in title and accessible name', () => {
    const html = renderToStaticMarkup(createElement(TaskIdentity, { harness: 'claude', model: 'claude-sonnet-4-6', compact: true }));

    expect(html).toContain('title="claude-sonnet-4-6"');
    expect(html).toContain('aria-label="claude-sonnet-4-6"');
    expect(html).toContain('>sonnet-4-6<');
    expect(html).toContain('>CL<');
  });
});

describe('task identity wiring', () => {
  it('renders through the shared TaskIdentity component in the table and deck surfaces', () => {
    expect(TABLE_VIEW).toContain('TaskIdentity');
    expect(DECK).toContain('TaskIdentity');
  });
});
