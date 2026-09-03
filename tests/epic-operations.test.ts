import { afterEach, describe, expect, it } from 'vitest';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { EpicOperations } from '../src/execution/epic-operations.js';
import { OperationRegistry } from '../src/telemetry/operations.js';

const providers: NodeTracerProvider[] = [];

afterEach(async () => {
  trace.disable();
  await Promise.all(providers.splice(0).map((provider) => provider.shutdown()));
});

function installOperations() {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new OperationRegistry(), new SimpleSpanProcessor(exporter)] });
  provider.register();
  providers.push(provider);
  return exporter;
}

describe('Epic Operations (issue #291)', () => {
  it('keeps cut, member work, healing, verification, integration, and retirement under one root across ticks', async () => {
    const exporter = installOperations();
    const operations = new EpicOperations();
    const context = { repoDir: '/workspaces/harmonic', epicRef: 291, epicTitle: 'Operations refinement' };

    for (const type of ['cut', 'member-merge', 'heal', 'member-merge', 'verify', 'merge', 'retire'] as const) {
      await operations.run({ ...context, type, work: async () => {} });
    }
    operations.complete(context);

    const spans = exporter.getFinishedSpans();
    const root = spans.find((span) => span.name === 'harmonic.epic');
    if (!root) throw new Error('Expected Epic root Operation');
    expect(spans.filter((span) => span.name === 'harmonic.epic').length).toBe(1);
    expect(root.attributes['epic.title']).toBe('Operations refinement');
    for (const span of spans.filter((span) => span.name !== 'harmonic.epic')) {
      expect(span.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    }
    expect(root.status.code).toBe(0);
  });

  it('finishes the Epic root with the terminal failure reason', async () => {
    const exporter = installOperations();
    const operations = new EpicOperations();
    const context = { repoDir: '/workspaces/harmonic', epicRef: 291 };

    await operations.run({ ...context, type: 'member-merge', work: async () => {} });
    operations.fail({ ...context, reason: 'rebase conflicted after the bounded heal' });

    const root = exporter.getFinishedSpans().find((span) => span.name === 'harmonic.epic');
    if (!root) throw new Error('Expected Epic root Operation');
    expect(root.status).toEqual({ code: 2, message: 'rebase conflicted after the bounded heal' });
    expect(root.attributes['harmonic.error.reason']).toBe('rebase conflicted after the bounded heal');
  });
});
