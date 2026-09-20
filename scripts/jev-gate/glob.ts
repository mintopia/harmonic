/**
 * A tiny glob matcher for the role-exemption patterns in jev.gate.json.
 * Supports exactly what those patterns use: `**` (any depth, incl. zero),
 * `*` (within a path segment), `?` (single char), and extglob alternation
 * `@(a|b|c)`. No dependency is added for this — the pattern set is small and
 * fixed, and a real glob library would be overkill for it.
 */
import type { GateConfig, RoleMatch } from './types.js';

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/g;

function escapeLiteral(chunk: string): string {
  return chunk.replace(REGEX_SPECIAL, '\\$&');
}

function compileGlob(pattern: string): RegExp {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 3;
      } else {
        out += '.*';
        i += 2;
      }
      continue;
    }
    if (c === '*') {
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (c === '@' && pattern[i + 1] === '(') {
      const close = pattern.indexOf(')', i + 2);
      if (close === -1) {
        out += escapeLiteral(c ?? '');
        i += 1;
        continue;
      }
      const alts = pattern
        .slice(i + 2, close)
        .split('|')
        .map((alt) => escapeLiteral(alt))
        .join('|');
      out += `(?:${alts})`;
      i = close + 1;
      continue;
    }
    out += escapeLiteral(c ?? '');
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

const compiledCache = new Map<string, RegExp>();

function compiledGlob(pattern: string): RegExp {
  let re = compiledCache.get(pattern);
  if (!re) {
    re = compileGlob(pattern);
    compiledCache.set(pattern, re);
  }
  return re;
}

/** `relPath` must use forward slashes (as `git diff --name-only` always emits). */
export function matchesGlob(relPath: string, pattern: string): boolean {
  return compiledGlob(pattern).test(relPath);
}

/** Classify a changed file's role by matching `config.roles` in order, first match wins. */
export function classifyRole(relPath: string, config: GateConfig): RoleMatch {
  for (const role of config.roles) {
    if (role.glob.some((pattern) => matchesGlob(relPath, pattern))) {
      return {
        roleName: role.name,
        skip: role.skip === true,
        exempt: new Set(role.exempt ?? []),
        hint: role.hint,
      };
    }
  }
  return { roleName: 'production', skip: false, exempt: new Set(), hint: undefined };
}

export function isSourceFile(relPath: string, sourceExtensions: readonly string[]): boolean {
  const dot = relPath.lastIndexOf('.');
  if (dot === -1) return false;
  const ext = relPath.slice(dot).toLowerCase();
  return sourceExtensions.includes(ext);
}

export function isInSkipDir(relPath: string, skipDirs: readonly string[]): boolean {
  const parts = relPath.split('/');
  return parts.some((part) => skipDirs.includes(part));
}
