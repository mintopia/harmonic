import {
  context,
  trace,
  type Attributes,
  type Counter,
  type Histogram,
  type Meter,
  type SpanContext,
  SpanStatusCode,
  type Context,
} from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-node';
import { forEachYielding } from '../reliability/yield.js';
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

export interface OperationMetricSummary {
  type: string;
  count: number;
  errorCount: number;
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

function snapshot(span: ReadableSpan): OperationSnapshot {
  return {
    type: span.name.slice('harmonic.'.length),
    name: span.name,
    spanContext: span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    attributes: { ...span.attributes },
    startedAt: timestampMs(span.startTime),
    ...(span.ended ? { endedAt: timestampMs(span.endTime) } : {}),
    status: { ...span.status },
  };
}

/** The in-memory source of truth for operations currently in progress. */
export class OperationRegistry implements SpanProcessor {
  private readonly live = new Map<string, Span>();
  private readonly rootSpanIds = new Set<string>();
  private readonly recent: OperationSnapshot[] = [];
  private readonly summaries = new Map<string, Omit<OperationMetricSummary, 'type'>>();
  private pendingSummaryTypes = new Set<string>();
  private bus: EventBus | undefined;
  private completedCounter: Counter | undefined;
  private errorCounter: Counter | undefined;
  private durationHistogram: Histogram | undefined;

  constructor(private readonly recentLimit = 100) {}

  setBus(bus: EventBus): void {
    this.bus = bus;
  }

  list(): OperationSnapshot[] {
    return [...this.live.values()].map(snapshot);
  }

  recentRoots(): OperationSnapshot[] {
    return this.recent.map((operation) => ({
      ...operation,
      spanContext: { ...operation.spanContext },
      ...(operation.parentSpanContext ? { parentSpanContext: { ...operation.parentSpanContext } } : {}),
      attributes: { ...operation.attributes },
      status: { ...operation.status },
    }));
  }

  configureMetrics(meter: Meter): void {
    this.completedCounter = meter.createCounter('harmonic.operations.completed');
    this.errorCounter = meter.createCounter('harmonic.operations.errors');
    this.durationHistogram = meter.createHistogram('harmonic.operations.duration', { unit: 'ms' });
  }

  async flushMetricSummaries(report: (summary: OperationMetricSummary) => void): Promise<void> {
    const pendingTypes = this.pendingSummaryTypes;
    this.pendingSummaryTypes = new Set();
    await forEachYielding(pendingTypes, (type) => {
      const summary = this.summaries.get(type);
      if (summary) report({ type, ...summary });
    });
  }

  onStart(span: Span, _parentContext: Context): void {
    const spanId = span.spanContext().spanId;
    const parentSpanId = span.parentSpanContext?.spanId;
    if (!parentSpanId || !registryForSpan.has(parentSpanId)) this.rootSpanIds.add(spanId);
    this.live.set(spanId, span);
    registryForSpan.set(spanId, this);
    this.emit('op-started', snapshot(span));
  }

  onEnd(span: ReadableSpan): void {
    const spanId = span.spanContext().spanId;
    const completed = snapshot(span);
    this.live.delete(spanId);
    registryForSpan.delete(spanId);
    if (this.rootSpanIds.delete(spanId)) this.remember(completed);
    this.recordMetrics(completed);
    this.emit('op-ended', completed);
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
    this.rootSpanIds.clear();
    this.recent.length = 0;
    this.summaries.clear();
    this.pendingSummaryTypes.clear();
    this.completedCounter = undefined;
    this.errorCounter = undefined;
    this.durationHistogram = undefined;
    return Promise.resolve();
  }

  private remember(operation: OperationSnapshot): void {
    if (this.recentLimit <= 0) return;
    this.recent.push(operation);
    if (this.recent.length > this.recentLimit) this.recent.shift();
  }

  private recordMetrics(operation: OperationSnapshot): void {
    const attributes = { 'harmonic.operation.type': operation.type };
    this.completedCounter?.add(1, attributes);
    this.durationHistogram?.record((operation.endedAt ?? operation.startedAt) - operation.startedAt, attributes);
    const summary = this.summaries.get(operation.type) ?? { count: 0, errorCount: 0 };
    summary.count += 1;
    if (operation.status.code === SpanStatusCode.ERROR) {
      this.errorCounter?.add(1, attributes);
      summary.errorCount += 1;
    }
    this.summaries.set(operation.type, summary);
    this.pendingSummaryTypes.add(operation.type);
  }

  private emit(type: OperationEventType, operation: OperationSnapshot): void {
    this.bus?.emit('operations', { type, operation });
  }
}

export const operationRegistry = new OperationRegistry();

export function startOperation({
  type,
  attributes,
  parent,
}: {
  type: string;
  attributes: Attributes;
  parent?: SpanContext | undefined;
}): Operation {
  const parentContext = parent ? trace.setSpanContext(context.active(), parent) : context.active();
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
