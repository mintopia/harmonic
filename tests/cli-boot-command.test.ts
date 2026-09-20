import { describe, expect, it } from 'vitest';
import { bootCommand } from '../src/cli-commands.js';

function assertNoUnquotedShellMetacharacters(command: string): void {
  const outsideQuotes = command.replace(/'[^']*'/g, '');
  expect(outsideQuotes).not.toMatch(/[;$`]/);
}

describe('bootCommand', () => {
  it('shell-quotes forwarded args containing shell metacharacters so pasting the boot hook cannot inject commands', () => {
    const command = bootCommand([
      '--data-dir',
      '/state',
      '--foo=bar; rm -rf /tmp/x',
      '--baz=$(whoami)',
      '--qux=`id`',
    ]);

    expect(command).toBe(
      "harmonic start --data-dir /state '--foo=bar; rm -rf /tmp/x' '--baz=$(whoami)' '--qux=`id`'",
    );

    assertNoUnquotedShellMetacharacters(command);
  });

  it('still strips --password and --password=... before quoting the rest', () => {
    expect(bootCommand(['--password', 'secret', '--data-dir', '/state'])).toBe('harmonic start --data-dir /state');
    expect(bootCommand(['--password=secret', '--data-dir', '/state'])).toBe('harmonic start --data-dir /state');
  });
});
