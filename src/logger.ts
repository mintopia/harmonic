import { context, trace } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type StdoutLogLevel = LogLevel | 'none';
type LogAttributeValue = string | number | boolean;
type LogAttributes = Record<string, LogAttributeValue | undefined>;

const severity: Record<LogLevel, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

const rank: Record<StdoutLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: Number.POSITIVE_INFINITY,
};

let stdoutLogLevel: StdoutLogLevel = 'info';

export function configureLogger(options: { stdoutLogLevel: StdoutLogLevel }): void {
  stdoutLogLevel = options.stdoutLogLevel;
}

function compactAttributes(attributes: LogAttributes | undefined): Record<string, LogAttributeValue> {
  return Object.fromEntries(
    Object.entries(attributes ?? {}).filter((entry): entry is [string, LogAttributeValue] => entry[1] !== undefined),
  );
}

function traceFields() {
  const spanContext = trace.getSpanContext(context.active());
  if (!spanContext) return {};
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}

function write(level: LogLevel, message: string, attributes: Record<string, LogAttributeValue>): void {
  if (rank[level] < rank[stdoutLogLevel]) return;
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...traceFields(),
      ...(Object.keys(attributes).length === 0 ? {} : { attributes }),
    })}\n`,
  );
}

function emit(level: LogLevel, message: string, attributes?: LogAttributes): void {
  const activeContext = context.active();
  const otelAttributes = compactAttributes(attributes);
  logs.getLogger('harmonic').emit({
    severityNumber: severity[level],
    severityText: level.toUpperCase(),
    body: message,
    ...(Object.keys(otelAttributes).length === 0 ? {} : { attributes: otelAttributes }),
    context: activeContext,
  });
  write(level, message, otelAttributes);
}

export const logger = {
  debug: (message: string, attributes?: LogAttributes): void => emit('debug', message, attributes),
  info: (message: string, attributes?: LogAttributes): void => emit('info', message, attributes),
  warn: (message: string, attributes?: LogAttributes): void => emit('warn', message, attributes),
  error: (message: string, attributes?: LogAttributes): void => emit('error', message, attributes),
};
