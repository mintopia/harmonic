import { describe, expect, it } from 'vitest';
import { ordinal } from '../web/src/components/TargetWaitChip.js';

describe('ordinal', () => {
  it('suffixes places in line', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th']);
  });
});
