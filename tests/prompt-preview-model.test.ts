import { describe, expect, it } from 'vitest';
import {
  SAMPLE_DRIVE_FIELDS,
  compileEpicCriticPreview,
} from '../web/src/prompt-preview-model.js';
import { bundledEnginePrompts } from '../src/domain/bundled-prompts.js';

const BUNDLED_PROMPTS = bundledEnginePrompts();

describe('prompt-preview-model (settings compiled preview)', () => {
  it('compiles an Epic critic against its ticket context', () => {
    const out = compileEpicCriticPreview('Review Epic {ref}: {title}.', BUNDLED_PROMPTS);

    expect(out).toContain(`Review Epic ${SAMPLE_DRIVE_FIELDS.ref}: ${SAMPLE_DRIVE_FIELDS.title}.`);
    expect(out).toContain('the referenced ticket');
    expect(out).toMatch(/READ-ONLY/i);
  });
});
