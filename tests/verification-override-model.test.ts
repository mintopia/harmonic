import { describe, expect, it } from 'vitest';
import {
  defaultHarnessId,
  harnessChoices,
  withMissingGlobals,
} from '../web/src/components/verification-override-model.js';

type CommandOverlayEntry =
  | { kind: 'global'; ref: string; enabled: boolean }
  | { kind: 'local'; enabled: boolean; command: { id: string; command: string; args: string[]; env: Record<string, string>; timeoutSeconds: number } };

describe('withMissingGlobals (ADR-0037)', () => {
  it('renders every global, in order, as an enabled row when the overlay is null', () => {
    expect(withMissingGlobals<CommandOverlayEntry>(null, ['a', 'b'])).toEqual([
      { kind: 'global', ref: 'a', enabled: true },
      { kind: 'global', ref: 'b', enabled: true },
    ]);
  });

  it('leaves an overlay that already names every global untouched', () => {
    const overlay: CommandOverlayEntry[] = [{ kind: 'global', ref: 'a', enabled: false }];
    expect(withMissingGlobals(overlay, ['a'])).toEqual(overlay);
  });

  it('appends a global not named by any entry, enabled, at the end', () => {
    const overlay: CommandOverlayEntry[] = [{ kind: 'local', enabled: true, command: { id: 'cmd-1', command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 } }];
    const rows = withMissingGlobals(overlay, ['a']);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({ kind: 'global', ref: 'a', enabled: true });
  });
});

describe('defaultHarnessId / harnessChoices', () => {
  const harness = (defaultModel: string) => ({ models: [{ id: defaultModel }], defaultModel });
  const config = (defaultsHarness: string) => ({
    defaults: { harness: defaultsHarness },
    harnesses: { claude: harness('opus'), codex: harness('gpt') },
  }) as unknown as Parameters<typeof defaultHarnessId>[0];

  it('uses the configured default Harness, else the first configured one', () => {
    expect(defaultHarnessId(config('codex'))).toBe('codex');
    expect(defaultHarnessId(config('missing'))).toBe('claude');
    expect(defaultHarnessId({ defaults: { harness: 'x' }, harnesses: {} } as unknown as Parameters<typeof defaultHarnessId>[0])).toBe('');
  });

  it('builds choices in config order with the default Harness recorded explicitly', () => {
    const built = harnessChoices(config('codex'));
    expect(Object.keys(built.byId)).toEqual(['claude', 'codex']);
    expect(built.defaultHarness).toBe('codex');
    expect(built.byId.codex).toEqual({ models: ['gpt'], defaultModel: 'gpt' });
  });
});
