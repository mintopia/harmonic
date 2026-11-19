import { parseArgs } from 'node:util';

export interface ServeValues {
  port: string;
  host: string;
  'data-dir'?: string;
  user?: string | undefined;
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
  | { kind: 'restart'; dataDir: string | undefined }
  | { kind: 'uninstall'; dataDir: string | undefined }
  | { kind: 'help'; exitCode: 0 | 1 }
  | { kind: 'version' }
  | { kind: 'serve'; values: ServeValues }
  | { kind: 'start'; values: ServeValues }
  | { kind: 'install'; values: ServeValues };

const OPTIONAL_SERVE_KEYS = [
  'data-dir',
  'user',
  'password',
  'otel-endpoint',
  'otel-headers',
  'otel-export',
  'otel-metric-export-interval',
  'otel-stdout-log-level',
] as const;

const DATA_DIR_COMMANDS = ['status', 'stop', 'restart', 'uninstall'] as const;
const SERVE_COMMANDS = ['serve', 'start', 'install'] as const;
const VERSION_FLAGS = ['version', '--version', '-v'] as const;
const HELP_REQUESTS = [undefined, 'help', '--help'];

function isOneOf<T extends string>(list: readonly T[], value: string | undefined): value is T {
  return value !== undefined && (list as readonly string[]).includes(value);
}

export function dispatchCli(argv: string[]): CliDispatch {
  const [command, ...rest] = argv;

  if (isOneOf(VERSION_FLAGS, command)) {
    return { kind: 'version' };
  }

  if (isOneOf(DATA_DIR_COMMANDS, command)) {
    const { values } = parseArgs({ args: rest, options: { 'data-dir': { type: 'string' } } });
    return { kind: command, dataDir: values['data-dir'] };
  }

  if (!isOneOf(SERVE_COMMANDS, command)) {
    return { kind: 'help', exitCode: HELP_REQUESTS.includes(command) ? 0 : 1 };
  }

  if (command === 'install' && rest.includes('--help')) return { kind: 'help', exitCode: 0 };

  const { values } = parseArgs({
    args: rest,
    options: {
      port: { type: 'string', default: '4700' },
      host: { type: 'string', default: '0.0.0.0' },
      'data-dir': { type: 'string' },
      user: { type: 'string' },
      password: { type: 'string' },
      'otel-endpoint': { type: 'string' },
      'otel-headers': { type: 'string' },
      'otel-export': { type: 'string' },
      'otel-metric-export-interval': { type: 'string' },
      'otel-stdout-log-level': { type: 'string' },
    },
  });

  const serveValues: ServeValues = {
    port: values.port ?? '4700',
    host: values.host ?? '0.0.0.0',
  };
  for (const key of OPTIONAL_SERVE_KEYS) {
    const value = values[key];
    if (value !== undefined) serveValues[key] = value;
  }
  return { kind: command, values: serveValues };
}
