import { describe, expect, it } from 'vitest';
import { dispatchCli } from '../src/cli-dispatch.js';

describe('dispatchCli', () => {
  it('routes no args to help with exit code 0', () => {
    expect(dispatchCli([])).toEqual({ kind: 'help', exitCode: 0 });
  });

  it('routes "help" to help with exit code 0', () => {
    expect(dispatchCli(['help'])).toEqual({ kind: 'help', exitCode: 0 });
  });

  it('routes "--help" to help with exit code 0', () => {
    expect(dispatchCli(['--help'])).toEqual({ kind: 'help', exitCode: 0 });
  });

  it('routes an unknown command to help with exit code 1', () => {
    expect(dispatchCli(['bogus'])).toEqual({ kind: 'help', exitCode: 1 });
  });

  it('routes "status" without --data-dir', () => {
    expect(dispatchCli(['status'])).toEqual({ kind: 'status', dataDir: undefined });
  });

  it('routes "status" with --data-dir', () => {
    expect(dispatchCli(['status', '--data-dir', '/x'])).toEqual({ kind: 'status', dataDir: '/x' });
  });

  it('routes "stop" without --data-dir', () => {
    expect(dispatchCli(['stop'])).toEqual({ kind: 'stop', dataDir: undefined });
  });

  it('routes "stop" with --data-dir', () => {
    expect(dispatchCli(['stop', '--data-dir', '/x'])).toEqual({ kind: 'stop', dataDir: '/x' });
  });

  it('routes "serve" with default port and host', () => {
    const dispatch = dispatchCli(['serve']);
    expect(dispatch.kind).toBe('serve');
    if (dispatch.kind !== 'serve') throw new Error('expected serve');
    expect(dispatch.values.port).toBe('4700');
    expect(dispatch.values.host).toBe('0.0.0.0');
  });

  it('routes "serve" with explicit options', () => {
    const dispatch = dispatchCli([
      'serve',
      '--port',
      '5000',
      '--host',
      '127.0.0.1',
      '--data-dir',
      '/d',
      '--password',
      'pw',
    ]);
    expect(dispatch.kind).toBe('serve');
    if (dispatch.kind !== 'serve') throw new Error('expected serve');
    expect(dispatch.values.port).toBe('5000');
    expect(dispatch.values.host).toBe('127.0.0.1');
    expect(dispatch.values['data-dir']).toBe('/d');
    expect(dispatch.values.password).toBe('pw');
  });

  it('routes "start" and parses otel options', () => {
    const dispatch = dispatchCli(['start', '--otel-export', 'true']);
    expect(dispatch.kind).toBe('start');
    if (dispatch.kind !== 'start') throw new Error('expected start');
    expect(dispatch.values['otel-export']).toBe('true');
  });
});
