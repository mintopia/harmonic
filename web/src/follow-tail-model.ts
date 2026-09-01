/** The scroll geometry the tail decision reads off a scroll container. */
export interface ScrollExtent {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** How close to the bottom (px) still counts as sitting at the live edge. A few
 * lines of slack keeps the tail engaged through sub-pixel rounding and the
 * momentary gap before an appended event lays out. */
export const TAIL_THRESHOLD_PX = 40;

/** Whether the viewport is at the live bottom edge, within the threshold.
 * Content shorter than the viewport can't scroll, so it reads as trivially at
 * the bottom — following, not released. */
export function isAtLiveEdge(extent: ScrollExtent, threshold = TAIL_THRESHOLD_PX): boolean {
  return extent.scrollHeight - extent.scrollTop - extent.clientHeight <= threshold;
}
