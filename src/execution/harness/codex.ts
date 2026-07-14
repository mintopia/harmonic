import type { HarnessAdapter } from './adapter.js';

/** Stub until the Codex support slice lands (issue 24, spike in issue 22). */
export const codexAdapter: HarnessAdapter = {
  spawnEnv: () => ({}),
  usage: null,
};
