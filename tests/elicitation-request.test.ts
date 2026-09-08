import { describe, expect, it } from 'vitest';
import { parseFormElicitation, type ElicitationField } from '../src/acp/elicitation-request.js';

// The exact wire shape claude-agent-acp emits for AskUserQuestion: each question
// is a `question_<n>` field (string+oneOf for single-select, array+anyOf items
// for multi-select) followed by a `question_<n>_custom` free-text "Other" field.
const askUserQuestion = {
  mode: 'form',
  sessionId: 'sess-1',
  toolCallId: 'call-9',
  message: 'Which auth approach should I take?',
  requestedSchema: {
    type: 'object',
    properties: {
      question_0: {
        type: 'string',
        oneOf: [
          { const: 'cookie', title: 'httpOnly cookie', description: 'Kills XSS.' },
          {
            const: 'rotate',
            title: 'Rotate refresh',
            _meta: { '_claude/askUserQuestionOption': { preview: 'set-cookie: …' } },
          },
        ],
      },
      question_0_custom: {
        type: 'string',
        title: 'Other',
        description: 'Type your own answer.',
        _meta: { _askUserQuestionCustomAnswer: { questionId: 'question_0', isCustomAnswer: true } },
      },
      question_1: {
        type: 'array',
        title: 'Surfaces',
        description: 'Which surfaces?',
        items: { anyOf: [{ const: 'web', title: 'Web' }, { const: 'cli', title: 'CLI' }] },
      },
    },
  },
};

describe('parseFormElicitation', () => {
  it('parses an AskUserQuestion form into render-ready fields', () => {
    const parsed = parseFormElicitation(askUserQuestion);
    expect(parsed).not.toBeNull();
    expect(parsed?.message).toBe('Which auth approach should I take?');
    expect(parsed?.toolCallId).toBe('call-9');
    expect(parsed?.fields).toHaveLength(3);

    const [q0, custom, q1] = parsed!.fields as [ElicitationField, ElicitationField, ElicitationField];
    expect(q0).toMatchObject({ key: 'question_0', kind: 'select', optional: true });
    expect(q0.options).toEqual([
      { value: 'cookie', label: 'httpOnly cookie', description: 'Kills XSS.' },
      { value: 'rotate', label: 'Rotate refresh', preview: 'set-cookie: …' },
    ]);
    expect(custom).toMatchObject({ key: 'question_0_custom', kind: 'text', title: 'Other' });
    expect(q1).toMatchObject({ key: 'question_1', kind: 'multiselect', title: 'Surfaces' });
    expect(q1.options).toEqual([
      { value: 'web', label: 'Web' },
      { value: 'cli', label: 'CLI' },
    ]);
  });

  it('marks fields listed in `required` as not optional', () => {
    const parsed = parseFormElicitation({
      ...askUserQuestion,
      requestedSchema: { ...askUserQuestion.requestedSchema, required: ['question_0'] },
    });
    expect(parsed?.fields.find((f) => f.key === 'question_0')?.optional).toBe(false);
    expect(parsed?.fields.find((f) => f.key === 'question_1')?.optional).toBe(true);
  });

  it('parses the refusal-fallback consent prompt (single-select)', () => {
    const parsed = parseFormElicitation({
      mode: 'form',
      sessionId: 'sess-1',
      message: 'Fable declined. Retry with Opus?',
      requestedSchema: {
        type: 'object',
        properties: {
          refusal_fallback_choice: {
            type: 'string',
            oneOf: [
              { const: 'retry_fallback', title: 'Retry with Opus' },
              { const: 'cancelled', title: 'Keep the refusal' },
            ],
          },
        },
      },
    });
    expect(parsed?.fields).toHaveLength(1);
    expect(parsed?.fields[0]).toMatchObject({ kind: 'select', key: 'refusal_fallback_choice' });
  });

  it('returns null for a url-mode elicitation we cannot present', () => {
    expect(parseFormElicitation({ mode: 'url', sessionId: 's', message: 'Open this', url: 'https://x' })).toBeNull();
  });

  it('returns null for a form with no fields', () => {
    expect(
      parseFormElicitation({ mode: 'form', sessionId: 's', message: 'hi', requestedSchema: { type: 'object', properties: {} } }),
    ).toBeNull();
  });

  it('returns null for a malformed request', () => {
    expect(parseFormElicitation({ mode: 'form' })).toBeNull();
    expect(parseFormElicitation(null)).toBeNull();
  });
});
