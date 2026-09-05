import os from 'node:os';
import type { EventBus } from './server/bus.js';
import { logger } from './logger.js';

/**
 * The host OS's 1/5/15-minute load averages, its CPU core count, and whether it
 * is saturated. `saturated` is the sampler's hysteresis state — the single
 * source that drives both the header tint and the edge logs, so the two never
 * disagree.
 */
export interface HostLoad {
  load1: number;
  load5: number;
  load15: number;
  cores: number;
  saturated: boolean;
}

export interface HostLoadSamplerOptions {
  /** Sampling cadence in ms. Default 5000. */
  intervalMs?: number | undefined;
}

/**
 * Reads `os.loadavg()` on a fixed tick and broadcasts each reading over the bus
 * as `host_load`. Saturation — 1-minute load ≥ core count, i.e. more runnable
 * work than cores — is edge-logged with hysteresis: a warn on crossing up, an
 * info only once load drops back below `recoverFraction × cores`, so a load
 * hovering on the boundary can't spam the log.
 */
export class HostLoadSampler {
  private static readonly recoverFraction = 0.75;
  private readonly cores = Math.max(1, os.cpus().length);
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private latest: HostLoad;
  private saturated: boolean;

  constructor(
    private readonly bus: EventBus,
    options: HostLoadSamplerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 5_000;
    const [load1 = 0, load5 = 0, load15 = 0] = os.loadavg();
    this.saturated = load1 >= this.cores;
    this.latest = { load1, load5, load15, cores: this.cores, saturated: this.saturated };
  }

  /** The most recent reading, sent to a client the moment its firehose opens. */
  current(): HostLoad {
    return this.latest;
  }

  /** Begin sampling. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  /** Stop sampling. Idempotent. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    const [load1 = 0, load5 = 0, load15 = 0] = os.loadavg();
    this.updateSaturation(load1);
    this.latest = { load1, load5, load15, cores: this.cores, saturated: this.saturated };
    this.bus.emit('host_load', this.latest);
  }

  private updateSaturation(load1: number): void {
    const recoverAt = this.cores * HostLoadSampler.recoverFraction;
    if (!this.saturated && load1 >= this.cores) {
      this.saturated = true;
      logger.warn(
        `[host-load] saturated: 1-min load ${load1.toFixed(2)} ≥ ${this.cores} cores — more runnable work than cores`,
      );
    } else if (this.saturated && load1 < recoverAt) {
      this.saturated = false;
      logger.info(`[host-load] recovered: 1-min load ${load1.toFixed(2)} back below ${recoverAt.toFixed(2)} (${this.cores} cores)`);
    }
  }
}
