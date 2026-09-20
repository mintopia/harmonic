import type { CategoryId, CategoryRubric, JevAnswer, RubricQuestion, Rubrics, SubAnswers } from './types.js';
import { ALL_CATEGORIES } from './types.js';

export function questionId(cat: CategoryId, sub: string): string {
  return `${cat}.${sub}`;
}

export function toJevQuestions(rubrics: Rubrics, exempt: ReadonlySet<CategoryId>): Record<string, RubricQuestion> {
  const out: Record<string, RubricQuestion> = {};
  for (const cat of ALL_CATEGORIES) {
    if (exempt.has(cat)) continue;
    for (const [sub, question] of Object.entries(rubrics[cat].questions)) {
      out[questionId(cat, sub)] = question;
    }
  }
  return out;
}

export interface AggregatedCategory {
  answer: JevAnswer;
  subs: SubAnswers;
  /** Set only for `min`: the sub id whose score decided the category answer. */
  decidedBy?: string;
}

function aggregateMin(subs: SubAnswers): AggregatedCategory {
  let decidedBy: string | undefined;
  let answer: JevAnswer | undefined;
  for (const [subId, a] of Object.entries(subs)) {
    const isLower = answer === undefined || a.score < answer.score || (a.score === answer.score && a.confidence < answer.confidence);
    if (isLower) {
      answer = a;
      decidedBy = subId;
    }
  }
  return { answer: answer ?? { score: 0, confidence: 0 }, subs, decidedBy };
}

function aggregateMean(subs: SubAnswers): AggregatedCategory {
  const values = Object.values(subs);
  const score = values.reduce((sum, a) => sum + a.score, 0) / values.length;
  const confidence = values.reduce((sum, a) => sum + a.confidence, 0) / values.length;
  return { answer: { score, confidence }, subs };
}

/** A missing or non-numeric sub-answer counts as score 0, confidence 0. */
export function aggregateCategory(
  rubric: CategoryRubric,
  cat: CategoryId,
  answers: Record<string, Partial<JevAnswer> | undefined>,
): AggregatedCategory {
  const subs: SubAnswers = {};
  for (const subId of Object.keys(rubric.questions)) {
    const raw = answers[questionId(cat, subId)];
    subs[subId] = {
      score: typeof raw?.score === 'number' ? raw.score : 0,
      confidence: typeof raw?.confidence === 'number' ? raw.confidence : 0,
    };
  }

  switch (rubric.aggregate) {
    case 'min':
      return aggregateMin(subs);
    case 'mean':
      return aggregateMean(subs);
    default: {
      const exhaustive: never = rubric.aggregate;
      throw new Error(`jev-gate: unknown aggregate "${String(exhaustive)}"`);
    }
  }
}
