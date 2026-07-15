import { describe, expect, it } from 'vitest';
import { filterModels } from '../web/src/components/modelFilter';

const MODELS = ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'];

describe('filterModels', () => {
  it('returns the full list for an empty or whitespace query', () => {
    expect(filterModels(MODELS, '')).toEqual(MODELS);
    expect(filterModels(MODELS, '   ')).toEqual(MODELS);
  });

  it('returns the full list when the query exactly equals an option', () => {
    expect(filterModels(MODELS, 'claude-opus-4-8')).toEqual(MODELS);
  });

  it('filters to case-insensitive substring matches', () => {
    expect(filterModels(MODELS, 'opus')).toEqual(['claude-opus-4-8']);
    expect(filterModels(MODELS, 'ku-4')).toEqual(['claude-haiku-4-5']);
    expect(filterModels(MODELS, 'CLAUDE')).toEqual(MODELS);
  });

  it('returns an empty list when nothing matches (a custom ID)', () => {
    expect(filterModels(MODELS, 'gpt-5.4-mini[low]')).toEqual([]);
  });

  it('handles an empty option list', () => {
    expect(filterModels([], 'anything')).toEqual([]);
  });
});
