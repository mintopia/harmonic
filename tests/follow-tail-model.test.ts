import { describe, expect, it } from 'vitest';
import { isAtLiveEdge, TAIL_THRESHOLD_PX } from '../web/src/follow-tail-model.js';

describe('isAtLiveEdge', () => {
  it('follows when the viewport sits at the very bottom', () => {
    expect(isAtLiveEdge({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
  });

  it('stays engaged within the threshold slack', () => {
    const almost = 1000 - 100 - (TAIL_THRESHOLD_PX - 1);
    expect(isAtLiveEdge({ scrollTop: almost, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
  });

  it('releases once scrolled up past the threshold', () => {
    const up = 1000 - 100 - (TAIL_THRESHOLD_PX + 1);
    expect(isAtLiveEdge({ scrollTop: up, scrollHeight: 1000, clientHeight: 100 })).toBe(false);
  });

  it('treats a non-scrolling pane as trivially at the edge', () => {
    expect(isAtLiveEdge({ scrollTop: 0, scrollHeight: 80, clientHeight: 300 })).toBe(true);
  });
});
