/**
 * Compaction scheduling and monitoring (#427)
 *
 * The scheduler owns the clock (interval or explicit cron-like cadence) and
 * reports what it did; the monitor turns a run history into metrics and alerts.
 * Both are transport-agnostic so they can be driven by a cron sidecar, a
 * Kubernetes CronJob, or an in-process timer.
 */

import type { EventCompactor, CompactOptions } from "./compactor.ts";
import { DEFAULT_COMPACTION_THRESHOLDS } from "./types.ts";
import type {
  CompactionAlert,
  CompactionMetrics,
  CompactionResult,
  CompactionThresholds,
} from "./types.ts";

export type SchedulerListener = (result: CompactionResult) => void;

export interface SchedulerOptions {
  /** Cadence between passes. Defaults to every 6 hours. */
  intervalMs?: number;
  /** Stop automatically after this many passes. Unlimited when omitted. */
  maxRuns?: number;
  /** Injectable timer so tests and sidecars can drive the schedule. */
  setTimer?: (handler: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface SchedulerStatus {
  running: boolean;
  intervalMs: number;
  runs: number;
  maxRuns: number | null;
  nextRunAt: number | null;
  lastResult: CompactionResult | null;
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export class CompactionScheduler {
  private readonly compactor: EventCompactor;
  private readonly options: Required<Omit<SchedulerOptions, "maxRuns">> &
    Pick<SchedulerOptions, "maxRuns">;
  private readonly listeners: SchedulerListener[] = [];
  private timer: unknown = null;
  private running = false;
  private runs = 0;
  private nextRunAt: number | null = null;
  private lastResult: CompactionResult | null = null;

  constructor(compactor: EventCompactor, options: SchedulerOptions = {}) {
    this.compactor = compactor;
    this.options = {
      intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
      setTimer: options.setTimer ?? ((handler, delayMs) => setTimeout(handler, delayMs)),
      clearTimer: options.clearTimer ?? ((handle) => clearTimeout(handle as never)),
      maxRuns: options.maxRuns,
    };
  }

  /** Registers a listener invoked after every pass. */
  onRun(listener: SchedulerListener): void {
    this.listeners.push(listener);
  }

  /** Begins the recurring schedule. Idempotent. */
  start(now: number = Date.now()): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(now);
  }

  /** Cancels the recurring schedule. Idempotent. */
  stop(): void {
    if (this.timer !== null) {
      this.options.clearTimer(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.nextRunAt = null;
  }

  /** Runs a pass immediately, outside the schedule. */
  runOnce(options: CompactOptions = {}): CompactionResult {
    return this.record(this.compactor.compact(options));
  }

  getStatus(): SchedulerStatus {
    return {
      running: this.running,
      intervalMs: this.options.intervalMs,
      runs: this.runs,
      maxRuns: this.options.maxRuns ?? null,
      nextRunAt: this.nextRunAt,
      lastResult: this.lastResult,
    };
  }

  /** Fires the pass the timer was waiting for. */
  tick(now: number = Date.now()): CompactionResult {
    this.timer = null;
    const result = this.runOnce({ now });
    if (this.running) this.scheduleNext(now);
    return result;
  }

  private scheduleNext(now: number): void {
    if (this.options.maxRuns !== undefined && this.runs >= this.options.maxRuns) {
      this.running = false;
      this.nextRunAt = null;
      return;
    }
    this.nextRunAt = now + this.options.intervalMs;
    this.timer = this.options.setTimer(() => this.tick(), this.options.intervalMs);
  }

  private record(result: CompactionResult): CompactionResult {
    this.runs += 1;
    this.lastResult = result;
    for (const listener of this.listeners) {
      try {
        listener(result);
      } catch {
        // A misbehaving listener must not abort the schedule.
      }
    }
    return result;
  }
}

/** Rolling metrics for a compaction workload. */
export class CompactionMonitor {
  private readonly thresholds: CompactionThresholds;
  private readonly history: CompactionResult[] = [];
  private failures = 0;

  constructor(thresholds: Partial<CompactionThresholds> = {}) {
    this.thresholds = { ...DEFAULT_COMPACTION_THRESHOLDS, ...thresholds };
  }

  /** Folds a pass into the metrics window. */
  record(result: CompactionResult): void {
    this.history.push(result);
    if (result.errors.length > 0) this.failures += 1;
  }

  snapshot(): CompactionMetrics {
    const byReason = {
      superseded: 0,
      "ttl-expired": 0,
      orphaned: 0,
      "unreferenced-segment": 0,
    } as CompactionMetrics["byReason"];
    let eventsCompacted = 0;
    let segmentsFreed = 0;
    let bytesReclaimed = 0;
    let totalDurationMs = 0;
    let lastRunAt: number | null = null;
    let lastDurationMs = 0;

    for (const result of this.history) {
      for (const entry of result.compacted) {
        byReason[entry.reason] += 1;
      }
      eventsCompacted += result.compacted.length;
      segmentsFreed += result.freedSegments.length;
      bytesReclaimed += result.reclaimedBytes;
      totalDurationMs += result.durationMs;
      lastRunAt = result.completedAt;
      lastDurationMs = result.durationMs;
    }

    return {
      runs: this.history.length,
      failures: this.failures,
      eventsCompacted,
      segmentsFreed,
      bytesReclaimed,
      lastRunAt,
      lastDurationMs,
      totalDurationMs,
      byReason,
    };
  }

  /** Raises alerts for thresholds the current posture breaches. */
  evaluate(now: number = Date.now()): CompactionAlert[] {
    const metrics = this.snapshot();
    const alerts: CompactionAlert[] = [];

    if (metrics.failures >= this.thresholds.maxFailures) {
      alerts.push({
        code: "repeated-failures",
        severity: "critical",
        message: `${metrics.failures} compaction runs reported errors (threshold ${this.thresholds.maxFailures})`,
      });
    }
    if (metrics.lastDurationMs > this.thresholds.maxDurationMs) {
      alerts.push({
        code: "slow-compaction",
        severity: "warning",
        message: `last compaction took ${metrics.lastDurationMs}ms (threshold ${this.thresholds.maxDurationMs}ms)`,
      });
    }
    if (
      metrics.runs > 0 &&
      metrics.lastRunAt !== null &&
      metrics.lastRunAt <= now - this.thresholds.maxRunIntervalMs
    ) {
      alerts.push({
        code: "stalled-scheduler",
        severity: "critical",
        message: `no successful compaction since ${new Date(metrics.lastRunAt).toISOString()}`,
      });
    }
    if (metrics.runs > 0 && metrics.bytesReclaimed / metrics.runs < this.thresholds.minBytesReclaimed) {
      alerts.push({
        code: "low-reclaim",
        severity: "info",
        message: `average reclaim ${(metrics.bytesReclaimed / metrics.runs).toFixed(0)} bytes per run is below ${this.thresholds.minBytesReclaimed}`,
      });
    }
    return alerts;
  }

  /** Prompts format expected by Prometheus text exposition. */
  toPrometheus(): string {
    const metrics = this.snapshot();
    const lines = [
      "# HELP event_compaction_runs_total Compaction passes executed.",
      "# TYPE event_compaction_runs_total counter",
      `event_compaction_runs_total ${metrics.runs}`,
      "# HELP event_compaction_failures_total Compaction passes that reported errors.",
      "# TYPE event_compaction_failures_total counter",
      `event_compaction_failures_total ${metrics.failures}`,
      "# HELP event_compaction_events_total Events removed by compaction.",
      "# TYPE event_compaction_events_total counter",
      `event_compaction_events_total ${metrics.eventsCompacted}`,
      "# HELP event_compaction_bytes_reclaimed_total Bytes reclaimed by compaction.",
      "# TYPE event_compaction_bytes_reclaimed_total counter",
      `event_compaction_bytes_reclaimed_total ${metrics.bytesReclaimed}`,
      "# HELP event_compaction_last_duration_ms Duration of the most recent pass.",
      "# TYPE event_compaction_last_duration_ms gauge",
      `event_compaction_last_duration_ms ${metrics.lastDurationMs}`,
    ];
    for (const [reason, count] of Object.entries(metrics.byReason)) {
      lines.push(
        "# HELP event_compaction_events_by_reason_total Events removed, by reason.",
        "# TYPE event_compaction_events_by_reason_total counter",
        `event_compaction_events_by_reason_total{reason="${reason}"} ${count}`
      );
    }
    return lines.join("\n");
  }
}
