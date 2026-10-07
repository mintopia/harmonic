import { describe, expect, it } from 'vitest';
import {
  firstRoutingOverlayError,
  newLocalEntry,
  overlayRows,
  routingOverlayErrors,
} from '../web/src/components/routing-label-overlay-model.js';
import type { RoutingLabelOverlayEntry } from '../web/src/types.js';

const globals = [
  { label: 'Reasoning', harness: 'claude', model: 'opus' },
  { label: 'cheap', harness: 'codex', model: 'mini' },
];
const local = (label: string, enabled = true): RoutingLabelOverlayEntry => ({
  kind: 'local',
  enabled,
  routingLabel: { label, harness: 'claude', model: 'm' },
});

describe('overlayRows', () => {
  it('inherits every global, lowercased and enabled, when the overlay is null', () => {
    expect(overlayRows(null, globals)).toEqual([
      { kind: 'global', ref: 'reasoning', enabled: true },
      { kind: 'global', ref: 'cheap', enabled: true },
    ]);
  });

  it('appends a global the overlay does not name', () => {
    const rows = overlayRows([local('x'), { kind: 'global', ref: 'cheap', enabled: false }], globals);
    expect(rows.map((r) => (r.kind === 'global' ? r.ref : 'local'))).toEqual(['local', 'cheap', 'reasoning']);
  });
});

describe('routingOverlayErrors', () => {
  it('flags a local label that duplicates an enabled global, case-insensitively', () => {
    const rows = overlayRows([local('REASONING')], globals);
    const [error] = routingOverlayErrors(rows, globals);
    expect(error?.globalRef).toBe('reasoning');
    expect(error?.message).toContain('duplicates the enabled Global label');
  });

  it('lets a local label reuse a disabled global label', () => {
    const rows = overlayRows([local('cheap'), { kind: 'global', ref: 'cheap', enabled: false }], globals);
    expect(routingOverlayErrors(rows, globals)[0]).toBeNull();
  });

  it('flags a repeated local label and an empty one, and skips disabled locals', () => {
    const rows = [local('a'), local('A'), local(' '), local('reasoning', false)];
    const errors = routingOverlayErrors(rows, globals);
    expect(errors[0]).toBeNull();
    expect(errors[1]?.message).toContain('already mapped above');
    expect(errors[2]?.message).toBe('Enter a label.');
    expect(errors[3]).toBeNull();
  });

  it('numbers the first error by displayed position', () => {
    const rows = [{ kind: 'global', ref: 'cheap', enabled: true } as const, local('cheap')];
    expect(firstRoutingOverlayError(rows, globals)).toContain('Routing Label 2:');
    expect(firstRoutingOverlayError(null, globals)).toBeNull();
  });
});

describe('newLocalEntry', () => {
  it('seeds an enabled blank local row', () => {
    expect(newLocalEntry('claude', 'opus')).toEqual({ kind: 'local', enabled: true, routingLabel: { label: '', harness: 'claude', model: 'opus' } });
  });
});
