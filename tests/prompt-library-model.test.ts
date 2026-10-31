import { describe, expect, it } from 'vitest';
import {
  applySuggestion,
  copyCode,
  countsLabel,
  filterPrompts,
  localIssues,
  malformedReference,
  parseSaveError,
  previewTree,
  suggestCode,
  usedByLabel,
  validateCode,
} from '../web/src/prompt-library-model.js';
import type { Prompt } from '../web/src/types.js';

function prompt(code: string, over: Partial<Prompt> = {}): Prompt {
  return { code, description: `${code} desc`, text: '', bundled: false, resolved: '', usedBy: [], ...over };
}

const LIB = [prompt('implement', { bundled: true }), prompt('critic', { bundled: true, description: 'Correctness Critic' }), prompt('team-style')];

describe('prompt library model', () => {
  it('filters by code or description, case-insensitively', () => {
    expect(filterPrompts(LIB, 'IMPL').map((p) => p.code)).toEqual(['implement']);
    expect(filterPrompts(LIB, 'correctness').map((p) => p.code)).toEqual(['critic']);
    expect(filterPrompts(LIB, '  ')).toHaveLength(3);
    expect(filterPrompts(LIB, 'zzz')).toEqual([]);
  });

  it('words the counts header', () => {
    expect(countsLabel(LIB)).toBe('3 prompts · 2 Bundled · 1 yours');
    expect(countsLabel([prompt('a')])).toBe('1 prompt · 0 Bundled · 1 yours');
  });

  it('labels used-by', () => {
    expect(usedByLabel({ usedBy: [] })).toBe('Unused');
    expect(usedByLabel({ usedBy: ['a'] })).toBe('1 prompt');
    expect(usedByLabel({ usedBy: ['a', 'b'] })).toBe('2 prompts');
  });

  it('names a duplicate <code>-copy and avoids taken names', () => {
    expect(copyCode('implement', LIB)).toBe('implement-copy');
    expect(copyCode('implement', [...LIB, prompt('implement-copy')])).toBe('implement-copy-2');
  });

  it('parses a cycle error onto the offending reference', () => {
    const text = 'Keep it small.\n${{ prompts.security-checklist }}';
    const issue = parseSaveError('Include cycle: team-style → security-checklist → team-style (ref abc)', text, []);
    expect(issue).toEqual({
      kind: 'cycle',
      field: 'text',
      path: ['team-style', 'security-checklist', 'team-style'],
      position: { line: 2, column: 1 },
    });
  });

  it('parses an unknown code with line, column and a suggestion', () => {
    const text = 'Run these checks.\nBefore: ${{ prompts.secuirty-checklist }}';
    const issue = parseSaveError('Prompt includes unknown prompt code: secuirty-checklist', text, ['security-checklist', 'implement']);
    expect(issue).toEqual({
      kind: 'unknown',
      field: 'text',
      code: 'secuirty-checklist',
      position: { line: 2, column: 9 },
      suggestion: 'security-checklist',
    });
  });

  it('offers no suggestion when nothing is close', () => {
    expect(suggestCode('zzzzzz', ['implement'])).toBeNull();
  });

  it('parses a duplicate-code conflict onto the code field and keeps other errors on the form', () => {
    expect(parseSaveError('A prompt with the code implement already exists', '', [])).toMatchObject({ kind: 'code', field: 'code' });
    expect(parseSaveError('boom', '', [])).toEqual({ kind: 'other', field: 'form', message: 'boom' });
  });

  it('finds an unclosed reference with its position', () => {
    expect(malformedReference('ok\nFinish in ${{ vars.report_format')).toEqual({ line: 2, column: 11 });
    expect(malformedReference('${{ a.b }} and ${{ c')).toEqual({ line: 1, column: 16 });
    expect(malformedReference('${{ a }} ${{ b')).toEqual({ line: 1, column: 10 });
    expect(malformedReference('${{ a.b }}')).toBeNull();
    expect(localIssues({ text: '${{ x' })).toHaveLength(1);
  });

  it('validates codes for format and duplicates', () => {
    expect(validateCode('', LIB)).toMatch(/Enter a code/);
    expect(validateCode('1bad', LIB)).toMatch(/starts with a letter/);
    expect(validateCode('implement', LIB)).toMatch(/already exists \(Bundled\)/);
    expect(validateCode('team-style', LIB)).toMatch(/already exists\. Choose/);
    expect(validateCode('fresh-one', LIB)).toBeNull();
  });

  it('applies a suggestion to every reference to the unknown code', () => {
    expect(applySuggestion('${{ prompts.sec }} x ${{prompts.sec}}', 'sec', 'security')).toBe('${{ prompts.security }} x ${{prompts.security}}');
  });

  it('builds a nested include preview with context values and unknown codes left as written', () => {
    const lookup = new Map([
      ['a', 'A body ${{ prompts.b }}'],
      ['b', 'B body'],
    ]);
    expect(previewTree('Hi ${{ ticket.title }} ${{ prompts.a }} ${{ prompts.nope }}', lookup)).toEqual([
      { kind: 'text', value: 'Hi ' },
      { kind: 'context', value: 'ticket.title' },
      { kind: 'text', value: ' ' },
      {
        kind: 'include',
        code: 'a',
        depth: 1,
        children: [
          { kind: 'text', value: 'A body ' },
          { kind: 'include', code: 'b', depth: 2, children: [{ kind: 'text', value: 'B body' }] },
        ],
      },
      { kind: 'text', value: ' ' },
      { kind: 'text', value: '${{ prompts.nope }}' },
    ]);
  });
});
