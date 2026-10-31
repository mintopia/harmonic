import { describe, expect, it, vi } from 'vitest';
import { killProcessGroup } from '../src/execution/process-groups.js';
import { PodProcess } from '../src/execution/pod-process.js';

describe('PodProcess', () => {
  it('emits one exit with the code, and ends stdout after buffered data', async () => {
    const proc = new PodProcess();
    const exits: unknown[] = [];
    proc.on('exit', (code, signal) => exits.push([code, signal]));
    proc.stdout.write('hello');
    proc.finish(3);
    proc.finish(4);
    expect(exits).toEqual([[3, null]]);
    const chunks: string[] = [];
    for await (const chunk of proc.stdout) chunks.push(String(chunk));
    expect(chunks.join('')).toBe('hello');
  });

  it('is killed through killProcessGroup without a pid by closing the attach', () => {
    const close = vi.fn();
    const proc = new PodProcess(close);
    const exits: unknown[] = [];
    proc.on('exit', (code, signal) => exits.push([code, signal]));
    killProcessGroup(proc.asChildProcess());
    expect(close).toHaveBeenCalledOnce();
    expect(exits).toEqual([[null, 'SIGKILL']]);
  });

  it('reports a stream error then exits', () => {
    const proc = new PodProcess();
    const seen: string[] = [];
    proc.on('error', (error: Error) => seen.push(error.message));
    proc.on('exit', () => seen.push('exit'));
    proc.fail(new Error('boom'));
    expect(seen).toEqual(['boom', 'exit']);
  });
});
