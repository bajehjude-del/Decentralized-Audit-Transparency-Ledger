/**
 * Issue #392 — SDK Metrics Collection
 *
 * Provides a lightweight in-memory metrics collector for high-throughput
 * SDK utilities: counters, gauges, histograms, and latency timers.
 */

export interface MetricSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, { count: number; sum: number; min: number; max: number; avg: number }>;
}

export class SDKMetricsCollector {
  private counters: Map<string, number> = new Map();
  private gauges: Map<string, number> = new Map();
  private histograms: Map<string, number[]> = new Map();

  increment(metricName: string, delta = 1): void {
    const current = this.counters.get(metricName) ?? 0;
    this.counters.set(metricName, current + delta);
  }

  setGauge(metricName: string, value: number): void {
    this.gauges.set(metricName, value);
  }

  record(metricName: string, value: number): void {
    let values = this.histograms.get(metricName);
    if (!values) {
      values = [];
      this.histograms.set(metricName, values);
    }
    values.push(value);
    // Keep max 1000 samples to prevent unbounded memory growth
    if (values.length > 1000) {
      values.shift();
    }
  }

  time<T>(metricName: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    return fn().finally(() => {
      this.record(metricName, Date.now() - start);
    });
  }

  getSnapshot(): MetricSnapshot {
    const counters: Record<string, number> = {};
    for (const [k, v] of this.counters) {
      counters[k] = v;
    }

    const gauges: Record<string, number> = {};
    for (const [k, v] of this.gauges) {
      gauges[k] = v;
    }

    const histograms: Record<string, { count: number; sum: number; min: number; max: number; avg: number }> = {};
    for (const [k, vals] of this.histograms) {
      if (vals.length === 0) continue;
      const count = vals.length;
      const sum = vals.reduce((a, b) => a + b, 0);
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const avg = sum / count;
      histograms[k] = { count, sum, min, max, avg };
    }

    return { counters, gauges, histograms };
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

export const sdkMetrics = new SDKMetricsCollector();
