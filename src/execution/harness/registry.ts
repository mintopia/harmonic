import type { HarnessId } from '../../config.js';
import type { HarnessAdapter } from './adapter.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { copilotAdapter } from './copilot.js';
import { opencodeAdapter } from './opencode.js';

const unknownAdapter: HarnessAdapter = {
  commandPrefix: '/',
  transcript: null,
  spawnEnv: () => ({}),
  mcpServers: () => [],
  unattendedPermissionMode: () => undefined,
  requiresUnattendedPermissionMode: false,
  usage: null,
};

/** The sole registration point for harness-specific adapters. */
const adapters: Record<HarnessId, HarnessAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  copilot: copilotAdapter,
  opencode: opencodeAdapter,
};

function isHarnessId(harnessId: string): harnessId is HarnessId {
  return Object.hasOwn(adapters, harnessId);
}

/** Lookup takes the untyped harness id off a TaskRow; unknown ids get a no-op adapter. */
export function adapterFor(harnessId: string): HarnessAdapter {
  return isHarnessId(harnessId) ? adapters[harnessId] : unknownAdapter;
}

/** Monotonic version of assumptions that make a mid-flight Session safe to resume. */
export const ADAPTER_VERSION = 1;

/** The `adapterVersion` string recorded on a Session, e.g. `claude@1`. */
export function adapterVersion(harnessId: string): string {
  return `${harnessId}@${ADAPTER_VERSION}`;
}
