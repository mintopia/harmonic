import { readFileSync } from 'node:fs';
import { diag, DiagConsoleLogger, DiagLogLevel, metrics } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { AlwaysOnSampler, BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-node';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { operationRegistry } from './telemetry/operations.js';

const DEFAULT_ENDPOINT = 'http://localhost:4318';
type StdoutLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

const diagLevels: Record<StdoutLogLevel, DiagLogLevel> = {
  debug: DiagLogLevel.DEBUG,
  info: DiagLogLevel.INFO,
  warn: DiagLogLevel.WARN,
  error: DiagLogLevel.ERROR,
  none: DiagLogLevel.NONE,
};

export interface TelemetryOptions {
  endpoint: string;
  headers: Record<string, string>;
  exportEnabled: boolean;
  stdoutLogLevel: StdoutLogLevel;
}

export interface TelemetryOverrides {
  endpoint?: string | undefined;
  headers?: string | undefined;
  exportEnabled?: string | undefined;
  stdoutLogLevel?: string | undefined;
}

export interface TelemetryController {
  shutdown(): Promise<void>;
}

export interface InitializeTelemetryOptions {
  extraSpanProcessors?: readonly SpanProcessor[] | undefined;
}

function parseHeaders(value: string | undefined): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(
    value.split(',').map((part) => {
      const separator = part.indexOf('=');
      const name = part.slice(0, separator).trim();
      const headerValue = part.slice(separator + 1).trim();
      if (separator < 1 || !name || !headerValue) throw new Error(`Invalid OTLP header: ${part}`);
      return [name, headerValue];
    }),
  );
}

function parseExportEnabled(value: string | undefined): boolean {
  if (value === undefined) return true;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('OTLP export must be true or false');
}

function parseStdoutLogLevel(value: string | undefined): StdoutLogLevel {
  const level = value?.toLowerCase() ?? 'info';
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error' || level === 'none') return level;
  throw new Error(`Invalid OTLP stdout log level: ${value}`);
}

function endpointFor(base: string, signal: 'traces' | 'logs' | 'metrics'): string {
  const normalized = base.replace(/\/+$/, '');
  return `${new URL(normalized).toString().replace(/\/$/, '')}/v1/${signal}`;
}

function packageVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'version' in parsed &&
    typeof parsed.version === 'string'
  ) {
    return parsed.version;
  }
  throw new Error('package.json must include a version');
}

export function resolveTelemetryOptions(overrides: TelemetryOverrides = {}): TelemetryOptions {
  const endpoint = overrides.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_ENDPOINT;
  new URL(endpoint);
  return {
    endpoint,
    headers: parseHeaders(overrides.headers ?? process.env.OTEL_EXPORTER_OTLP_HEADERS),
    exportEnabled: parseExportEnabled(overrides.exportEnabled ?? process.env.OTEL_EXPORTER_OTLP_ENABLED),
    stdoutLogLevel: parseStdoutLogLevel(overrides.stdoutLogLevel ?? process.env.OTEL_STDOUT_LOG_LEVEL),
  };
}

let controller: TelemetryController | undefined;

export function initializeTelemetry(
  options: TelemetryOptions,
  initOptions: InitializeTelemetryOptions = {},
): TelemetryController {
  if (controller) return controller;

  const resource = resourceFromAttributes({
    [SEMRESATTRS_SERVICE_NAME]: 'harmonic',
    [SEMRESATTRS_SERVICE_VERSION]: packageVersion(),
  });
  const tracerProvider = new NodeTracerProvider({
    resource,
    sampler: new AlwaysOnSampler(),
    spanProcessors: [
      operationRegistry,
      ...(initOptions.extraSpanProcessors ?? []),
      ...(options.exportEnabled
        ? [new BatchSpanProcessor(new OTLPTraceExporter({ url: endpointFor(options.endpoint, 'traces'), headers: options.headers }))]
        : []),
    ],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: options.exportEnabled
      ? [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: endpointFor(options.endpoint, 'logs'), headers: options.headers }) })]
      : [],
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: options.exportEnabled
      ? [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: endpointFor(options.endpoint, 'metrics'), headers: options.headers }) })]
      : [],
  });

  tracerProvider.register();
  logs.setGlobalLoggerProvider(loggerProvider);
  metrics.setGlobalMeterProvider(meterProvider);
  diag.setLogger(new DiagConsoleLogger(), diagLevels[options.stdoutLogLevel]);

  controller = {
    async shutdown(): Promise<void> {
      await Promise.allSettled([tracerProvider.forceFlush(), loggerProvider.forceFlush(), meterProvider.forceFlush()]);
      await Promise.allSettled([tracerProvider.shutdown(), loggerProvider.shutdown(), meterProvider.shutdown()]);
      controller = undefined;
    },
  };
  return controller;
}
