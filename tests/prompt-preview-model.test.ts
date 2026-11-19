import { describe, expect, it } from 'vitest';
import {
  SAMPLE_DRIVE_FIELDS,
  fillSample,
} from '../web/src/prompt-preview-model.js';

describe('prompt-preview-model (settings compiled preview)', () => {
  it('fills {field} and ${{ }} tokens with sample values, keeping unnamed vars visible', () => {
    expect(fillSample('Fix {title} (${{ ticket.ref }}) in ${{ vars.style }}.')).toBe(`Fix ${SAMPLE_DRIVE_FIELDS.title} (${SAMPLE_DRIVE_FIELDS.ref}) in <style>.`);
  });

  it('leaves a malformed expression as written', () => {
    expect(fillSample('Broken ${{ ticket. }} {title}')).toBe('Broken ${{ ticket. }} {title}');
  });
});
