import { describe, expect, it } from 'vitest';
import { aggregateCategory, questionId, toJevQuestions } from '../scripts/jev-gate/aggregate.js';
import { ALL_CATEGORIES, type CategoryRubric, type RubricQuestion, type Rubrics } from '../scripts/jev-gate/types.js';

const q = (instructions: string): RubricQuestion => ({ type: 'score', instructions, criteria: ['worst', 'best'] });

const minRubric: CategoryRubric = {
  aggregate: 'min',
  questions: { a: q('question a'), b: q('question b'), c: q('question c') },
};

const meanRubric: CategoryRubric = {
  aggregate: 'mean',
  questions: { a: q('question a'), b: q('question b') },
};

describe('questionId', () => {
  it('joins category and sub id with a dot', () => {
    expect(questionId('security', 'injection')).toBe('security.injection');
  });
});

describe('toJevQuestions', () => {
  it('flattens every category to cat.sub ids', () => {
    const trivialRubric: CategoryRubric = { aggregate: 'min', questions: { only: q('trivial') } };
    const rubrics = Object.fromEntries(ALL_CATEGORIES.map((cat) => [cat, trivialRubric])) as Rubrics;
    const flat = toJevQuestions({ ...rubrics, security: minRubric, comments: meanRubric }, new Set());
    expect(flat['security.a']).toBe(minRubric.questions['a']);
    expect(flat['security.b']).toBe(minRubric.questions['b']);
    expect(flat['security.c']).toBe(minRubric.questions['c']);
    expect(flat['comments.a']).toBe(meanRubric.questions['a']);
    expect(flat['comments.b']).toBe(meanRubric.questions['b']);
    expect(flat['complexity_clean_code.only']).toBe(trivialRubric.questions['only']);
  });

  it('omits every sub-question of an exempt category', () => {
    const trivialRubric: CategoryRubric = { aggregate: 'min', questions: { only: q('trivial') } };
    const rubrics = Object.fromEntries(ALL_CATEGORIES.map((cat) => [cat, trivialRubric])) as Rubrics;
    const flat = toJevQuestions({ ...rubrics, security: minRubric, comments: meanRubric }, new Set(['security', 'testability']));
    expect(Object.keys(flat).some((id) => id.startsWith('security.'))).toBe(false);
    expect(Object.keys(flat).some((id) => id.startsWith('testability.'))).toBe(false);
    expect(flat['comments.a']).toBe(meanRubric.questions['a']);
    expect(flat['complexity_clean_code.only']).toBe(trivialRubric.questions['only']);
  });
});

describe('aggregateCategory', () => {
  it('min: takes the lowest sub score and its confidence, and reports decidedBy', () => {
    const answers = {
      'security.a': { score: 3, confidence: 0.9 },
      'security.b': { score: 1, confidence: 0.4 },
      'security.c': { score: 2, confidence: 0.8 },
    };
    const result = aggregateCategory(minRubric, 'security', answers);
    expect(result.answer).toEqual({ score: 1, confidence: 0.4 });
    expect(result.decidedBy).toBe('b');
    expect(result.subs).toEqual({ a: { score: 3, confidence: 0.9 }, b: { score: 1, confidence: 0.4 }, c: { score: 2, confidence: 0.8 } });
  });

  it('min: breaks a score tie by picking the lower confidence', () => {
    const answers = {
      'security.a': { score: 1, confidence: 0.9 },
      'security.b': { score: 1, confidence: 0.2 },
      'security.c': { score: 4, confidence: 1 },
    };
    const result = aggregateCategory(minRubric, 'security', answers);
    expect(result.answer).toEqual({ score: 1, confidence: 0.2 });
    expect(result.decidedBy).toBe('b');
  });

  it('mean: averages sub scores and confidences, with no decidedBy', () => {
    const answers = {
      'comments.a': { score: 2, confidence: 0.6 },
      'comments.b': { score: 4, confidence: 1.0 },
    };
    const result = aggregateCategory(meanRubric, 'comments', answers);
    expect(result.answer.score).toBeCloseTo(3);
    expect(result.answer.confidence).toBeCloseTo(0.8);
    expect(result.decidedBy).toBeUndefined();
  });

  it('treats a missing sub-answer as score 0, confidence 0', () => {
    const answers = { 'security.a': { score: 3, confidence: 0.9 } };
    const result = aggregateCategory(minRubric, 'security', answers);
    expect(result.subs['b']).toEqual({ score: 0, confidence: 0 });
    expect(result.subs['c']).toEqual({ score: 0, confidence: 0 });
    expect(result.answer).toEqual({ score: 0, confidence: 0 });
  });

  it('treats a non-numeric sub-answer as score 0, confidence 0', () => {
    const answers = {
      'comments.a': { score: 'nope' as unknown as number, confidence: 0.6 },
      'comments.b': { score: 2, confidence: 0.4 },
    };
    const result = aggregateCategory(meanRubric, 'comments', answers);
    expect(result.subs['a']).toEqual({ score: 0, confidence: 0.6 });
    expect(result.answer.score).toBeCloseTo(1);
  });
});
