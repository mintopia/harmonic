import type { RedactPattern } from '../config.js';
import type { ByteTransform } from './tar-gz.js';

export interface RedactionPattern extends RedactPattern {
  flags?: string;
}

export const BASELINE_REDACT_PATTERNS: readonly RedactionPattern[] = [
  { id: 'aws-access-key', regex: '\\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\\b' },
  {
    id: 'aws-secret-key',
    regex: '(?<=aws_?secret_?(?:access_?)?key["\']?\\s*[:=]\\s*["\']?)[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])',
    flags: 'i',
  },
  { id: 'github-token', regex: '\\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\\b' },
  { id: 'gitlab-token', regex: '\\bglpat-[A-Za-z0-9_-]{20,255}' },
  { id: 'bearer', regex: '(?<=\\bbearer\\s+)(?=[A-Za-z._~+/-]*[0-9])[A-Za-z0-9._~+/-]{16,2048}=*', flags: 'i' },
  { id: 'sk-api-key', regex: '\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,255}' },
];

const LOSSLESS_ENCODING = 'latin1';
const MAX_STRADDLING_MATCH = 4096;
const LOOKBEHIND_CONTEXT = 256;
const MAX_CARRY = 64 * 1024;

interface Compiled {
  id: string;
  re: RegExp;
}

interface Span {
  start: number;
  end: number;
}

function find(re: RegExp, text: string, from: number): Span | null {
  for (let at = from; at <= text.length; ) {
    re.lastIndex = at;
    const m = re.exec(text);
    if (!m) return null;
    if (m[0].length > 0) return { start: m.index, end: m.index + m[0].length };
    at = m.index + 1;
  }
  return null;
}

export class Redactor {
  readonly counts: Record<string, number> = {};
  private readonly compiled: Compiled[];

  constructor(patterns: readonly RedactionPattern[]) {
    this.compiled = patterns.map((p) => ({ id: p.id, re: new RegExp(p.regex, `g${p.flags ?? ''}`) }));
    for (const p of patterns) this.counts[p.id] = 0;
  }

  redactText(text: string): string {
    const stream = this.stream();
    return Buffer.concat([stream.push(Buffer.from(text, 'utf8')), stream.end()]).toString('utf8');
  }

  stream(opts: { count?: boolean } = {}): ByteTransform {
    const count = opts.count ?? true;
    let text = '';
    let from = 0;
    const run = (final: boolean): Buffer => {
      const out: string[] = [];
      const limit = final ? text.length : Math.max(from, text.length - MAX_STRADDLING_MATCH);
      const next: Array<Span | null | undefined> = new Array(this.compiled.length);
      let pos = from;
      let cut: number | null = null;
      for (;;) {
        let hit: { span: Span; index: number } | null = null;
        for (let index = 0; index < this.compiled.length; index++) {
          const cached = next[index];
          const span = cached === undefined || (cached !== null && cached.start < pos) ? find(this.compiled[index]!.re, text, pos) : cached;
          next[index] = span;
          if (span && (!hit || span.start < hit.span.start || (span.start === hit.span.start && span.end > hit.span.end))) hit = { span, index };
        }
        if (!hit || hit.span.start >= limit) break;
        if (!final && hit.span.end >= text.length && text.length - hit.span.start < MAX_CARRY) {
          cut = hit.span.start;
          break;
        }
        const id = this.compiled[hit.index]!.id;
        out.push(text.slice(pos, hit.span.start), `[REDACTED:${id}]`);
        if (count) this.counts[id]! += 1;
        pos = hit.span.end;
      }
      const end = cut ?? Math.max(limit, pos);
      out.push(text.slice(pos, end));
      const keep = Math.max(0, end - LOOKBEHIND_CONTEXT);
      text = text.slice(keep);
      from = end - keep;
      return Buffer.from(out.join(''), LOSSLESS_ENCODING);
    };
    return {
      push: (chunk) => {
        text += chunk.toString(LOSSLESS_ENCODING);
        return run(false);
      },
      end: () => run(true),
    };
  }
}
