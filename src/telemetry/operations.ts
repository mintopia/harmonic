import { context, trace, type Attributes, type SpanContext, SpanStatusCode, type Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-node';
import type { EventBus } from '../server/bus.js';

export type OperationEventType = 'op-started' | 'op-updated' | 'op-ended';

export interface OperationSnapshot {
  type: string;
  name: string;
  spanContext: SpanContext;
  parentSpanContext: SpanContext | undefined;
  attributes: Attributes;
  startedAt: number;
  endedAt?: number | undefined;
  status: { code: SpanStatusCode; message?: string | undefined };
}

export interface OperationEvent {
  type: OperationEventType;
  operation: OperationSnapshot;
}

export interface Operation {
  readonly spanContext: SpanContext;
  /** Runs work with this Operation as the active AsyncLocalStorage span. */
  run<T>(work: () => T): T;
  update(attributes: Attributes): void;
  end(): void;
  fail(reason: string): void;
}

const registryForSpan = new Map<string, OperationRegistry>();

function timestampMs([seconds, nanoseconds]: readonly [number, number]): number {
  return seconds * 1_000 + nanoseconds / 1_000_000;
}

function snapshot(span: ReadableSpan | Span): OperationSnapshot {
  const readable = span as ReadableSpan;
  return {
    type: readable.name.slice('harmonic.'.length),
    name: readable.name,
    spanContext: span.spanContext(),
    parentSpanContext: readable.parentSpanContext,
    attributes: { ...readable.attributes },
    startedAt: timestampMs(readable.startTime),
    ...(readable.ended ? { endedAt: timestampMs(readable.endTime) } : {}),
    status: { ...readable.status },
  };
}

/** The in-memory source of truth for operations currently in progress. */
export class OperationRegistry implements SpanProcessor {
  private readonly live = new Map<string, Span>();
  private bus: EventBus | undefined;

  setBus(bus: EventBus): void {
    this.bus = bus;
  }

  list(): OperationSnapshot[] {
    return [...this.live.values()].map(snapshot);
  }

  onStart(span: Span, _parentContext: Context): void {
    this.live.set(span.spanContext().spanId, span);
    registryForSpan.set(span.spanContext().spanId, this);
    this.emit('op-started', snapshot(span));
  }

  onEnd(span: ReadableSpan): void {
    this.live.delete(span.spanContext().spanId);
    registryForSpan.delete(span.spanContext().spanId);
    this.emit('op-ended', snapshot(span));
  }

  update(span: Span): void {
    if (this.live.has(span.spanContext().spanId)) this.emit('op-updated', snapshot(span));
  }

  updateById(spanId: string): void {
    const span = this.live.get(spanId);
    if (span) this.update(span);
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.live.clear();
    return Promise.resolve();
  }

  private emit(type: OperationEventType, operation: OperationSnapshot): void {
    this.bus?.emit('operations', { type, operation });
  }
}

export const operationRegistry = new OperationRegistry();

/**
 * Start a child only when the current span is a live Harmonic Operation.
 * Instrumented primitives use this to stay silent when called on their own,
 * rather than creating unhelpful root operations for every low-level action.
 */
export function startActiveChildOperation(type: string, attributes: Attributes): Operation | undefined {
  const active = trace.getActiveSpan();
  if (!active || !registryForSpan.has(active.spanContext().spanId)) return undefined;
  return startOperation(type, attributes);
}

export function startOperation(
  type: string,
  attributes: Attributes,
  options: { parent?: SpanContext | undefined } = {},
): Operation {
  const parentContext = options.parent ? trace.setSpanContext(context.active(), options.parent) : context.active();
  const span = trace.getTracer('harmonic').startSpan(
    `harmonic.${type}`,
    { attributes: { 'harmonic.operation.type': type, ...attributes } },
    parentContext,
  );
  let ended = false;

  const end = (): void => {
    if (ended) return;
    ended = true;
    span.end();
  };

  return {
    spanContext: span.spanContext(),
    run: <T>(work: () => T): T => context.with(trace.setSpan(parentContext, span), work),
    update: (updated: Attributes): void => {
      span.setAttributes(updated);
      registryForSpan.get(span.spanContext().spanId)?.updateById(span.spanContext().spanId);
    },
    end,
    fail: (reason: string): void => {
      span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
      span.setAttribute('harmonic.error.reason', reason);
      end();
    },
  };
}
