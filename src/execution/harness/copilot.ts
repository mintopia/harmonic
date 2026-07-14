import type { HarnessAdapter } from './adapter.js';

/** Stub until the Copilot support slice lands (issue 26, spike in issue 25). */
export const copilotAdapter: HarnessAdapter = {
  spawnEnv: () => ({}),
  usage: null,
};
