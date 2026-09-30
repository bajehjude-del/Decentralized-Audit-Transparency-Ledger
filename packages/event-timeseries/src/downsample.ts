/**
 * Downsampling for contract event time series (#430)
 *
 * Two independent flavors:
 *
 * - `downsample(events, bucketMs, method)` collapses every `bucketMs` window
 *   to a single representative point (avg/min/max/sum/count/last).
 * - `lttb(events, threshold)` keeps a fixed number of points while preserving
 *   the visual shape of the series, used for long-term archive tiers.
 */

import type { AggregateKind, TimeSeriesEvent } from "./types.ts";
import { alignedStart, TimeSeriesError } from "./types.ts";

const SAMPLE_METHODS: AggregateKind[] = ["avg", "min", "max", "sum", "count", "last"];

function isSamplingMethod(method: AggregateKind): boolean {
  return SAMPLE_METHODS.includes(method);
}

/**
 * Reduces a series to one point per aligned bucket. Input need not be
 * pre-sorted, but ordering is preserved within the same bucket.
 */
export function downsample(
  events: readonly TimeSeriesEvent[],
  bucketMs: number,
  method: AggregateKind
): TimeSeriesEvent[] {
  if (bucketMs <= 0) {
    throw new TimeSeriesError("invalid-argument", `bucketMs must be positive, got ${bucketMs}`);
  }
  if (!isSamplingMethod(method)) {
    throw new TimeSeriesError("invalid-argument", `method ${method} is not a bucket aggregation`);
  }
  const buckets = new Map<number, number[]>();
  for (const event of events) {
    const start = alignedStart(event.timestamp, bucketMs);
    const list = buckets.get(start);
    if (list === undefined) buckets.set(start, [event.value]);
    else list.push(event.value);
  }
  const starts = [...buckets.keys()].sort((a, b) => a - b);
  const sampled: TimeSeriesEvent[] = [];
  for (const start of starts) {
    const values = buckets.get(start) as number[];
    sampled.push({
      timestamp: start,
      stream: events[0].stream,
      value: reduce(values, method),
    });
  }
  return sampled;
}

function reduce(values: number[], method: AggregateKind): number {
  let acc = values[0];
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (method === "min") acc = Math.min(acc, v);
    else if (method === "max") acc = Math.max(acc, v);
    else acc += v;
  }
  if (method === "avg") return acc / values.length;
  if (method === "last") return values[values.length - 1];
  return method === "count" ? values.length : acc;
}

/**
 * Largest-Triangle-Three-Buckets downsampling: keeps `threshold` points while
 * retaining the shape of the series. Selected points are exact original
 * observations.
 */
export function lttb(
  events: readonly TimeSeriesEvent[],
  threshold: number
): TimeSeriesEvent[] {
  if (events.length === 0) return [];
  const stream = events[0].stream;
  const ordered = events.slice().sort((a, b) => a.timestamp - b.timestamp);
  const n = ordered.length;
  if (n <= threshold || threshold < 2 || !Number.isFinite(threshold)) {
    return ordered.map((event) => ({ ...event }));
  }
  if (threshold === 2) return [ordered[0], ordered[n - 1]].map((event) => ({ ...event }));

  const sampled: TimeSeriesEvent[] = [];
  const bucketSize = (n - 2) / (threshold - 2);
  let a = 0;
  sampled.push({ ...ordered[0] });

  for (let i = 0; i < threshold - 2; i++) {
    const avgStart = Math.floor((i + 1) * bucketSize) + 1;
    const avgEnd = Math.max(avgStart + 1, Math.min(Math.floor((i + 2) * bucketSize) + 1, n));
    let avgX = 0;
    let avgY = 0;
    for (let j = avgStart; j < avgEnd; j++) {
      avgX += ordered[j].timestamp;
      avgY += ordered[j].value;
    }
    const avgLen = avgEnd - avgStart;
    avgX /= avgLen;
    avgY /= avgLen;

    const rangeStart = Math.floor(i * bucketSize) + 1;
    const rangeEnd = Math.max(rangeStart + 1, Math.floor((i + 1) * bucketSize) + 1);
    const anchor = ordered[a];
    let maxArea = -1;
    let chosen = rangeStart;
    for (let j = rangeStart; j < rangeEnd && j < n; j++) {
      const area = Math.abs(
        (anchor.timestamp - avgX) * (ordered[j].value - anchor.value) -
          (anchor.timestamp - ordered[j].timestamp) * (avgY - anchor.value)
      );
      if (area > maxArea) {
        maxArea = area;
        chosen = j;
      }
    }
    sampled.push({ ...ordered[chosen] });
    a = chosen;
  }

  sampled.push({ ...ordered[n - 1] });
  return sampled;
}

export interface DownsampledTier {
  tierIndex: number;
  points: TimeSeriesEvent[];
}

/**
 * Reduces a set of points with a method. Bucket methods collapse every window;
 * `lttb` reduces the whole set to `minPoints` shape-preserving points.
 */
export function downsampleWith(
  events: readonly TimeSeriesEvent[],
  method: AggregateKind,
  bucketMs: number,
  minPoints: number
): TimeSeriesEvent[] {
  if (events.length === 0) return [];
  if (method === "lttb") return lttb(events, minPoints);
  if (bucketMs <= 0) return events.slice().sort((a, b) => a.timestamp - b.timestamp);
  return downsample(events, bucketMs, method);
}

/** Single representative point for a fully covered bucket window. */
export function bucketValue(
  events: readonly TimeSeriesEvent[],
  bucketMs: number,
  kind: AggregateKind
): { start: number; value: number; count: number } {
  const values = events.map((event) => event.value);
  return {
    start: alignedStart(events[0].timestamp, bucketMs),
    value: reduce(values, kind),
    count: values.length,
  };
}