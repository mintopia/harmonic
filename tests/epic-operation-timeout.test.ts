import { describe, expect, it } from 'vitest';
import { DEFAULT_EPIC_OPERATION_TIMEOUT_MS } from '../src/execution/epic-coordinator.js';
import { RESOLVE_TURN_TIMEOUT_MS } from '../src/execution/merge-coordinator.js';

describe('Epic operation timeout', () => {
  it('outlasts two conflict-resolution turns', () => {
    expect(DEFAULT_EPIC_OPERATION_TIMEOUT_MS).toBeGreaterThan(2 * RESOLVE_TURN_TIMEOUT_MS);
  });
});
