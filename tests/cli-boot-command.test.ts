import { beforeAll, describe, expect, it, vi } from 'vitest';

async function importCliTriggeringSynchronousMain(argv: string[]): Promise<typeof import('../src/cli.js')> {
  const originalArgv = process.argv;
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.argv = argv;
  try {
    return await import('../src/cli.js');
  } finally {
    process.argv = originalArgv;
    stdoutSpy.mockRestore();
  }
}

let bootCommand: (rest: string[]) => string;

function assertNoUnquotedShellMetacharacters(command: string): void {
  const outsideQuotes = command.replace(/'[^']*'/g, '');
  expect(outsideQuotes).not.toMatch(/[;$`]/);
}

beforeAll(async () => {
  ({ bootCommand } = await importCliTriggeringSynchronousMain(['node', '/opt/harmonic/dist/cli.js', 'version']));
});

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
