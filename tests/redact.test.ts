import { describe, expect, it } from 'vitest';
import { BASELINE_REDACT_PATTERNS, Redactor } from '../src/archive/redact.js';

const GITHUB = `ghp_${'A1b2C3d4E5'.repeat(3)}abcdef`;

function streamThrough(redactor: Redactor, input: string, size: number): string {
  const stream = redactor.stream();
  const out: Buffer[] = [];
  const bytes = Buffer.from(input, 'utf8');
  for (let i = 0; i < bytes.length; i += size) out.push(stream.push(bytes.subarray(i, i + size)));
  out.push(stream.end());
  return Buffer.concat(out).toString('utf8');
}

describe('Redactor', () => {
  it('ships the baseline pattern ids', () => {
    expect(BASELINE_REDACT_PATTERNS.map((p) => p.id)).toEqual([
      'aws-access-key',
      'aws-secret-key',
      'github-token',
      'gitlab-token',
      'bearer',
      'sk-api-key',
    ]);
  });

  it.each([
    ['aws-access-key', 'key=AKIAIOSFODNN7EXAMPLE end', 'key=[REDACTED:aws-access-key] end'],
    ['aws-secret-key', 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n', 'aws_secret_access_key = [REDACTED:aws-secret-key]\n'],
    ['github-token', `token ${GITHUB} ok`, 'token [REDACTED:github-token] ok'],
    ['github-token', `x github_pat_${'a'.repeat(22)}_${'B'.repeat(59)} y`, 'x [REDACTED:github-token] y'],
    ['gitlab-token', 'glpat-abcdefghij0123456789 done', '[REDACTED:gitlab-token] done'],
    ['bearer', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def', 'Authorization: Bearer [REDACTED:bearer]'],
    ['sk-api-key', 'OPENAI=sk-proj-abcdefghijklmnopqrstuvwx', 'OPENAI=[REDACTED:sk-api-key]'],
    ['sk-api-key', 'k sk-ant-api03-abcdefghijklmnopqrstuvwx', 'k [REDACTED:sk-api-key]'],
  ])('redacts a %s', (id, input, expected) => {
    const redactor = new Redactor(BASELINE_REDACT_PATTERNS);
    expect(redactor.redactText(input)).toBe(expected);
    expect(redactor.counts[id]).toBe(1);
  });

  it('leaves prose after "Bearer" alone', () => {
    const text = 'Use Bearer authentication with a Bearer token.';
    expect(new Redactor(BASELINE_REDACT_PATTERNS).redactText(text)).toBe(text);
  });

  it('leaves a 40-hex commit SHA alone', () => {
    const sha = 'a06ec50229e39b66e4197605339875ba379865a8';
    expect(new Redactor(BASELINE_REDACT_PATTERNS).redactText(`commit ${sha}`)).toBe(`commit ${sha}`);
  });

  it('applies extra patterns alongside the baseline and reports every id', () => {
    const redactor = new Redactor([...BASELINE_REDACT_PATTERNS, { id: 'internal-host', regex: 'corp\\.example\\.internal' }]);
    expect(redactor.redactText(`curl https://corp.example.internal -H 'x: ${GITHUB}'`)).toBe(
      "curl https://[REDACTED:internal-host] -H 'x: [REDACTED:github-token]'",
    );
    expect(redactor.counts).toEqual({
      'aws-access-key': 0,
      'aws-secret-key': 0,
      'github-token': 1,
      'gitlab-token': 0,
      bearer: 0,
      'sk-api-key': 0,
      'internal-host': 1,
    });
  });

  it('sums counts across streams and repeated matches', () => {
    const redactor = new Redactor(BASELINE_REDACT_PATTERNS);
    redactor.redactText(`${GITHUB} and ${GITHUB}`);
    streamThrough(redactor, `again ${GITHUB}`, 7);
    expect(redactor.counts['github-token']).toBe(3);
  });

  it('does not count a measuring stream', () => {
    const redactor = new Redactor(BASELINE_REDACT_PATTERNS);
    const stream = redactor.stream({ count: false });
    stream.push(Buffer.from(GITHUB));
    stream.end();
    expect(redactor.counts['github-token']).toBe(0);
  });

  it.each([1, 3, 7, 13, 64, 4096])('redacts a secret split across %i-byte chunks', (size) => {
    const input = `${'x'.repeat(5000)} before ${GITHUB} mid Bearer abcdefgh1jklmnopqr\n${'é'.repeat(3000)} AKIAIOSFODNN7EXAMPLE tail`;
    const redactor = new Redactor(BASELINE_REDACT_PATTERNS);
    const out = streamThrough(redactor, input, size);
    expect(out).toBe(new Redactor(BASELINE_REDACT_PATTERNS).redactText(input));
    expect(out).not.toContain(GITHUB);
    expect(out).toContain('[REDACTED:github-token]');
    expect(out).toContain('Bearer [REDACTED:bearer]');
    expect(out).toContain('[REDACTED:aws-access-key] tail');
    expect(redactor.counts['github-token']).toBe(1);
    expect(redactor.counts.bearer).toBe(1);
  });

  it('does not match across a boundary that only looks like a word start', () => {
    const input = 'xXAKIAIOSFODNN7EXAMPLE';
    for (const size of [1, 2, 3]) {
      expect(streamThrough(new Redactor(BASELINE_REDACT_PATTERNS), input, size)).toBe(input);
    }
  });

  it('passes non-UTF-8 bytes through unchanged', () => {
    const bytes = Buffer.from([0xff, 0x00, 0xc3, 0x28, 0x80, 0x41]);
    const stream = new Redactor(BASELINE_REDACT_PATTERNS).stream();
    expect(Buffer.concat([stream.push(bytes.subarray(0, 3)), stream.push(bytes.subarray(3)), stream.end()])).toEqual(bytes);
  });

  it('ignores a pattern that matches the empty string', () => {
    const redactor = new Redactor([{ id: 'empty', regex: 'z*' }]);
    expect(redactor.redactText('abc zz d')).toBe('abc [REDACTED:empty] d');
  });
});
