import { logger } from '../logger.js';

export interface StallInfo {
  /** Time the loop was blocked beyond the nominal probe delay, in ms. */
  lagMs: number;
  /** The probe's measured delay (nominal `probeMs` + `lagMs`), in ms. */
  delayMs: number;
}

export interface EventLoopMonitorOptions {
  /** Probe cadence: the timer's nominal delay, in ms. Default 1000. */
  probeMs?: number | undefined;
  /** Overshoot above `probeMs` that counts as a stall, in ms. Default 200. */
  stallMs?: number | undefined;
  /**
   * Minimum ms between reported stalls, so a sustained stall logs once rather
   * than on every probe behind it. Default 5000.
   */
  reportThrottleMs?: number | undefined;
/** Sink for a detected stall. Default: the shared logger. */
  onStall?: ((info: StallInfo) => void) | undefined;
  /** Monotonic clock in ms. Default `Date.now`. */
  now?: (() => number) | undefined;
  /**
   * Timer scheduler. Default `setTimeout` with the handle `.unref()`'d so the
   * probe never keeps the process alive. Injected in tests.
   */
  setTimer?: ((fn: () => void, ms: number) => unknown) | undefined;
  /** Timer canceller matching {@link EventLoopMonitorOptions.setTimer}. */
  clearTimer?: ((handle: unknown) => void) | undefined;
}

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const handle = setTimeout(fn, ms);
  (handle as { unref?: () => void }).unref?.();
  return handle;
}

function defaultOnStall(info: StallInfo): void {
  logger.warn(
    `[event-loop] stalled ${info.lagMs}ms (probe delayed to ${info.delayMs}ms) — a sync query or a non-yielding loop blocked the event loop`,
  );
}

export class EventLoopMonitor {
  private readonly probeMs: number;
  private readonly stallMs: number;
  private readonly reportThrottleMs: number;
  private readonly onStall: (info: StallInfo) => void;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private handle: unknown = undefined;
  private scheduledAt = 0;
  private running = false;
  private lastLag = 0;
  private lastReportAt = Number.NEGATIVE_INFINITY;

  constructor(options: EventLoopMonitorOptions = {}) {
    this.probeMs = options.probeMs ?? 1000;
    this.stallMs = options.stallMs ?? 200;
    this.reportThrottleMs = options.reportThrottleMs ?? 5000;
    this.onStall = options.onStall ?? defaultOnStall;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** The most recent probe's measured lag (ms). 0 before the first probe. */
  get lastLagMs(): number {
    return this.lastLag;
  }

  /** Begin probing. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.arm();
  }

  /** Stop probing and cancel any pending probe. Idempotent. */
  stop(): void {
    this.running = false;
    if (this.handle !== undefined) {
      this.clearTimer(this.handle);
      this.handle = undefined;
    }
  }

  private arm(): void {
    this.scheduledAt = this.now();
    this.handle = this.setTimer(() => {
      this.handle = undefined;
      this.probe();
    }, this.probeMs);
  }

  private probe(): void {
    if (!this.running) return;
    const delayMs = this.now() - this.scheduledAt;
    const lagMs = Math.max(0, delayMs - this.probeMs);
    this.lastLag = lagMs;
    if (lagMs >= this.stallMs && this.now() - this.lastReportAt >= this.reportThrottleMs) {
      this.lastReportAt = this.now();
      this.onStall({ lagMs, delayMs });
    }
    this.arm();
  }
}
