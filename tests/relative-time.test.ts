import { expect, it } from 'vitest';
import { elapsedShort } from '../web/src/relative-time.js';

it('shortens elapsed time to the largest whole unit', () => {
  const now = 10_000_000_000;
  expect([0, 30_000, 4 * 60_000, 3 * 3_600_000, 50 * 3_600_000].map((d) => elapsedShort(now - d, now))).toEqual(['0s', '30s', '4m', '3h', '2d']);
  expect(elapsedShort(now + 5000, now)).toBe('0s');
});
