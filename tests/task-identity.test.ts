import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskIdentity, formatModelKey, formatModelLabel, providerLabel } from '../web/src/components/TaskIdentity.js';

const TABLE_VIEW = readFileSync(
  fileURLToPath(new URL('../web/src/components/TableView.tsx', import.meta.url)),
  'utf8',
);

const BOARD = readFileSync(
  fileURLToPath(new URL('../web/src/components/Board.tsx', import.meta.url)),
  'utf8',
);

describe('formatModelLabel', () => {
  it('shows a friendly name for known Claude ids', () => {
    expect(formatModelLabel('claude-sonnet-4-6')).toBe('Sonnet 4.6');
    expect(formatModelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(formatModelLabel('claude-haiku-5-5')).toBe('Haiku 5.5');
    expect(formatModelLabel('claude-opus-4-1-20250805')).toBe('Opus 4.1');
    expect(formatModelLabel('claude-opus-4-20250514')).toBe('Opus 4');
    expect(formatModelLabel('opus-4.8')).toBe('Opus 4.8');
    expect(formatModelLabel('sonnet-5')).toBe('Sonnet 5');
    expect(formatModelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(formatModelLabel('openrouter/anthropic/claude-sonnet-5.5')).toBe('Sonnet 5.5');
  });

  it('leaves Codex, Copilot and unknown ids as the full raw id', () => {
    expect(formatModelLabel('gpt-5-codex')).toBe('gpt-5-codex');
    expect(formatModelLabel('gpt-5.3-codex')).toBe('gpt-5.3-codex');
    expect(formatModelLabel('gpt-5-mini')).toBe('gpt-5-mini');
    expect(formatModelLabel('stub-model')).toBe('stub-model');
    expect(formatModelLabel('gpt-5')).toBe('gpt-5');
    expect(formatModelLabel('o4-mini')).toBe('o4-mini');
  });
});

describe('formatModelKey', () => {
  it('formats only the id part of a role-qualified key', () => {
    expect(formatModelKey('claude-sonnet-4-6 · sub')).toBe('Sonnet 4.6 · sub');
    expect(formatModelKey('critic')).toBe('critic');
  });
});

describe('TaskIdentity', () => {
  it('shows the shortened model but preserves the full model in title and accessible name', () => {
    const html = renderToStaticMarkup(createElement(TaskIdentity, { harness: 'claude', model: 'claude-sonnet-4-6', compact: true }));

    expect(html).toContain('title="claude-sonnet-4-6"');
    expect(html).toContain('aria-label="claude-sonnet-4-6"');
    expect(html).toContain('>Sonnet 4.6<');
    expect(html).toContain('>Claude<');
  });
});

describe('providerLabel', () => {
  it('uses product names for supported harnesses', () => {
    expect(providerLabel('claude')).toBe('Claude');
    expect(providerLabel('codex')).toBe('Codex');
    expect(providerLabel('opencode')).toBe('OpenCode');
  });
});

describe('task identity wiring', () => {
  it('renders through the shared TaskIdentity component in the table and Board surfaces', () => {
    expect(TABLE_VIEW).toContain('TaskIdentity');
    expect(BOARD).toContain('TaskIdentity');
  });
});
