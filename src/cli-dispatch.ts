import { parseArgs } from 'node:util';

export interface ServeValues {
  port: string;
  host: string;
  'data-dir'?: string;
  password?: string;
  'otel-endpoint'?: string;
  'otel-headers'?: string;
  'otel-export'?: string;
  'otel-metric-export-interval'?: string;
  'otel-stdout-log-level'?: string;
}

export type CliDispatch =
  | { kind: 'status'; dataDir: string | undefined }
  | { kind: 'stop'; dataDir: string | undefined }
  | { kind: 'help'; exitCode: 0 | 1 }
  | { kind: 'serve'; values: ServeValues }
  | { kind: 'start'; values: ServeValues };

export function dispatchCli(argv: string[]): CliDispatch {
  const [command, ...rest] = argv;

  if (command === 'status' || command === 'stop') {
    const { values } = parseArgs({ args: rest, options: { 'data-dir': { type: 'string' } } });
    return { kind: command, dataDir: values['data-dir'] };
  }

  if (command !== 'serve' && command !== 'start') {
    return { kind: 'help', exitCode: command === undefined || command === 'help' || command === '--help' ? 0 : 1 };
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      port: { type: 'string', default: '4700' },
      host: { type: 'string', default: '0.0.0.0' },
      'data-dir': { type: 'string' },
      password: { type: 'string' },
      'otel-endpoint': { type: 'string' },
      'otel-headers': { type: 'string' },
      'otel-export': { type: 'string' },
      'otel-metric-export-interval': { type: 'string' },
      'otel-stdout-log-level': { type: 'string' },
    },
  });

  return { kind: command, values: values as ServeValues };
}
