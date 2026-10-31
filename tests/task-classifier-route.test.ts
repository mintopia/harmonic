import { describe, expect, it } from 'vitest';
import { classifierRouteOf } from '../src/domain/task-routing.js';

const chosen = { routeKind: 'classifier', routeOption: 'opus-deep', routeReason: 'hard' } as const;
const abstained = { routeKind: 'abstained', routeOption: null, routeReason: 'timed out' } as const;

describe('classifierRouteOf', () => {
  const base = { enabled: true, labelMatched: false, operatorSet: false };

  it('reports the latest Attempt as routed or abstained', () => {
    expect(classifierRouteOf({ ...base, latest: chosen })).toEqual({ kind: 'routed', optionId: 'opus-deep', reason: 'hard' });
    expect(classifierRouteOf({ ...base, latest: abstained })).toEqual({ kind: 'abstained', optionId: null, reason: 'timed out' });
  });

  it('is null when no Attempt consulted the classifier', () => {
    expect(classifierRouteOf({ ...base, latest: undefined })).toBeNull();
    expect(classifierRouteOf({ ...base, latest: { routeKind: null, routeOption: null, routeReason: null } })).toBeNull();
  });

  it('reports overridden when an operator setting wins and the classifier is on, even over a stale record', () => {
    expect(classifierRouteOf({ ...base, operatorSet: true, latest: chosen })).toEqual({ kind: 'overridden', optionId: null, reason: null });
    expect(classifierRouteOf({ ...base, operatorSet: true, enabled: false, latest: undefined })).toBeNull();
  });

  it('is null when a Routing Label decided', () => {
    expect(classifierRouteOf({ ...base, labelMatched: true, latest: chosen })).toBeNull();
  });
});
