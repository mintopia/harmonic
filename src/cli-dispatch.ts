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
  | { kind: 'restart'; dataDir: string | undefined }
  | { kind: 'uninstall'; dataDir: string | undefined }
  | { kind: 'help'; exitCode: 0 | 1 }
  | { kind: 'version' }
  | { kind: 'serve'; values: ServeValues }
  | { kind: 'start'; values: ServeValues }
  | { kind: 'install'; values: ServeValues };

export function dispatchCli(argv: string[]): CliDispatch {
  const [command, ...rest] = argv;

  if (command === 'version' || command === '--version' || command === '-v') {
    return { kind: 'version' };
  }

  if (command === 'status' || command === 'stop' || command === 'restart' || command === 'uninstall') {
    const { values } = parseArgs({ args: rest, options: { 'data-dir': { type: 'string' } } });
    return { kind: command, dataDir: values['data-dir'] };
  }

  if (command !== 'serve' && command !== 'start' && command !== 'install') {
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

  const serveValues: ServeValues = {
    port: values.port ?? '4700',
    host: values.host ?? '0.0.0.0',
  };
  if (values['data-dir'] !== undefined) serveValues['data-dir'] = values['data-dir'];
  if (values.password !== undefined) serveValues.password = values.password;
  if (values['otel-endpoint'] !== undefined) serveValues['otel-endpoint'] = values['otel-endpoint'];
  if (values['otel-headers'] !== undefined) serveValues['otel-headers'] = values['otel-headers'];
  if (values['otel-export'] !== undefined) serveValues['otel-export'] = values['otel-export'];
  if (values['otel-metric-export-interval'] !== undefined) {
    serveValues['otel-metric-export-interval'] = values['otel-metric-export-interval'];
  }
  if (values['otel-stdout-log-level'] !== undefined) {
    serveValues['otel-stdout-log-level'] = values['otel-stdout-log-level'];
  }
  return { kind: command, values: serveValues };
}
