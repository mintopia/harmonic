import type { OperationEvent } from './ws.js';

export type Operation = OperationEvent['operation'];

export interface OperationForest {
  operations: Operation[];
  recent: Operation[];
}

const RECENT_LIMIT = 100;
const SUPPRESSED_OPERATION_TYPES = new Set(['tracker.mirror.issue', 'harmonic.job']);

function isSuppressed(operation: Operation): boolean {
  return SUPPRESSED_OPERATION_TYPES.has(operation.type);
}

function visibleOperation(operation: Operation): Operation | null {
  if (isSuppressed(operation)) return null;
  return {
    ...operation,
    children: operation.children.flatMap((child) => {
      const visible = visibleOperation(child);
      return visible === null ? [] : [visible];
    }),
  };
}

/** Removes noisy operations that do not help operators understand system state. */
export function visibleOperationForest(forest: OperationForest): OperationForest {
  const visible = (operations: readonly Operation[]) => operations.flatMap((operation) => {
    const next = visibleOperation(operation);
    return next === null ? [] : [next];
  });
  return { operations: visible(forest.operations), recent: visible(forest.recent) };
}

function removeOperation(operations: readonly Operation[], spanId: string): Operation[] {
  return operations.flatMap((operation) => {
    if (operation.spanId === spanId) return [];
    return [{ ...operation, children: removeOperation(operation.children, spanId) }];
  });
}

function findOperation(operations: readonly Operation[], spanId: string): Operation | undefined {
  for (const operation of operations) {
    if (operation.spanId === spanId) return operation;
    const child = findOperation(operation.children, spanId);
    if (child) return child;
  }
  return undefined;
}

function upsertOperation(operations: readonly Operation[], next: Operation): Operation[] {
  const current = findOperation(operations, next.spanId);
  const replacement = current && next.children.length === 0 ? { ...next, children: current.children } : next;
  const without = removeOperation(operations, replacement.spanId);
  if (replacement.parentSpanId === null) return [...without, replacement];

  const attach = (items: readonly Operation[]): [Operation[], boolean] => {
    let attached = false;
    const result = items.map((operation) => {
      if (operation.spanId === replacement.parentSpanId) {
        attached = true;
        return { ...operation, children: [...removeOperation(operation.children, replacement.spanId), replacement] };
      }
      const [children, found] = attach(operation.children);
      if (found) attached = true;
      return found ? { ...operation, children } : operation;
    });
    return [result, attached];
  };
  const [withChild, attached] = attach(without);
  return attached ? withChild : [...withChild, next];
}

function recentWith(recent: readonly Operation[], operation: Operation): Operation[] {
  return [operation, ...recent.filter((candidate) => candidate.spanId !== operation.spanId)].slice(0, RECENT_LIMIT);
}

/** Applies one firehose event to the same operation forest returned by GET /api/operations. */
export function operationForest(forest: OperationForest, event: OperationEvent): OperationForest {
  if (isSuppressed(event.operation)) return forest;
  if (event.type === 'op-ended') {
    const operations = removeOperation(forest.operations, event.operation.spanId);
    return event.operation.parentSpanId === null
      ? { operations, recent: recentWith(forest.recent, event.operation) }
      : { ...forest, operations };
  }
  return { ...forest, operations: upsertOperation(forest.operations, event.operation) };
}

/** Convenience seam for callers holding only the live forest. */
export function mergeOperationEvent(operations: readonly Operation[], event: OperationEvent): Operation[] {
  return operationForest({ operations: [...operations], recent: [] }, event).operations;
}
