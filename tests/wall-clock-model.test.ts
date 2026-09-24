import { describe, expect, it } from 'vitest';
import { wallClockRemaining } from '../web/src/wall-clock-model.js';

describe('wallClockRemaining', () => {
  it('formats sub-hour remaining time in minutes', () => {
    const now = 0;
    const deadline = 42 * 60_000;
    expect(wallClockRemaining(deadline, now)).toEqual({ label: '42m left', overdue: false });
  });

  it('formats hour-plus remaining time as "Xh MMm left", zero-padded', () => {
    const now = 0;
    const deadline = (60 + 5) * 60_000;
    expect(wallClockRemaining(deadline, now)).toEqual({ label: '1h 05m left', overdue: false });
  });

  it('rounds up to the minute so it never under-reports while time remains', () => {
    const now = 0;
    const deadline = 90_000; // 1m30s
    expect(wallClockRemaining(deadline, now)).toEqual({ label: '2m left', overdue: false });
  });

  it('reports "0m left" and overdue once the deadline has passed', () => {
    const now = 10_000;
    const deadline = 0;
    expect(wallClockRemaining(deadline, now)).toEqual({ label: '0m left', overdue: true });
  });

  it('treats the deadline instant itself as overdue', () => {
    expect(wallClockRemaining(1_000, 1_000)).toEqual({ label: '0m left', overdue: true });
  });
});
