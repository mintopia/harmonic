import type { HarnessConfig } from '../types';

export interface HarnessRow {
  id: string;
  command: string;
  status: 'ready' | 'not-configured';
  statusLabel: string;
  modelCount: number;
}

export function harnessRows(harnesses: Record<string, HarnessConfig>): HarnessRow[] {
  return Object.entries(harnesses).map(([id, harness]) => {
    const command = [harness.command, ...harness.args].join(' ').trim();
    const ready = harness.command.trim() !== '';
    return {
      id,
      command,
      status: ready ? 'ready' : 'not-configured',
      statusLabel: ready ? 'Ready' : 'Not configured',
      modelCount: harness.models.length,
    };
  });
}
