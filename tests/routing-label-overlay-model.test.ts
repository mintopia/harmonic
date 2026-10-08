import { describe, expect, it } from 'vitest';
import {
  firstRoutingOverlayError,
  newLocalEntry,
  overlayRows,
  isIssueVisible,
  routingIssueMessage,
  routingIssueText,
} from '../web/src/components/routing-label-overlay-model.js';
import { routingLabelOverlayIssues } from '../src/domain/setting-override.js';
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

describe('routing overlay issue messages', () => {
  it('names the enabled global a local label duplicates', () => {
    const rows = overlayRows([local('REASONING')], globals);
    const [issue] = routingLabelOverlayIssues(rows, globals);
    expect(issue).toEqual({ index: 0, kind: 'duplicate-global', globalRef: 'reasoning' });
    expect(routingIssueText(issue!, 'REASONING').globalRef).toBe('reasoning');
    expect(routingIssueMessage(issue!, 'REASONING')).toContain('duplicates the enabled Global label reasoning');
  });

  it('shows the blank-label prompt only once the row was touched', () => {
    const blank = { index: 0, kind: 'blank' } as const;
    expect(isIssueVisible(blank, false)).toBe(false);
    expect(isIssueVisible(blank, true)).toBe(true);
    expect(isIssueVisible({ index: 0, kind: 'duplicate' }, false)).toBe(true);
    expect(isIssueVisible(undefined, true)).toBe(false);
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
