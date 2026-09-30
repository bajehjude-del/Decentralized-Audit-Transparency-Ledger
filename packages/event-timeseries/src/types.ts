/**
 * Time-series optimization for contract events (#430)
 *
 * Shared types for the package, including the retention tier and continuous
 * aggregate model.
 */

export interface TimeSeriesEvent {
  /** Unix timestamp in milliseconds. */
  timestamp: number;
  /** Logical series name, e.g. a resource id or metric name. */
  stream: string;
  /** Numeric observation at the timestamp. */
  value: number;
}

export type DownsampleMethod = "lttb" | "avg" | "min" | "max" | "sum" | "count" | "last";

export type AggregateKind = DownsampleMethod;

/**
 * A retention tier: events older than `maxAgeMs` are promoted to the next
 * tier. `bucketMs` is the window width used when downsampling the tier (0
 * keeps events raw). With method `lttb`, `minPoints` caps how many sampled
 * points the tier keeps.
 */
export interface RetentionTier {
  name: string;
  /** Oldest age in milliseconds a point may have while staying in this tier. */
  maxAgeMs: number;
  /** Sampling bucket width in ms; 0 keeps the tier raw. */
  bucketMs: number;
  /** Downsampling method used when materializing this tier. */
  method: DownsampleMethod;
  /** Target point count for the `lttb` method on this tier. */
  minPoints: number;
}

/** A completed aggregate bucket (half-open interval [start, end)). */
export interface AggregateBucket {
  start: number;
  end: number;
  stream: string;
  kind: AggregateKind;
  bucketMs: number;
  value: number;
  count: number;
}

/** A named materialized view definition. */
export interface ViewDefinition {
  name: string;
  stream: string;
  kind: AggregateKind;
  bucketMs: number;
}

export type TimeSeriesErrorCode =
  | "unknown-stream"
  | "unknown-tier"
  | "unknown-view"
  | "invalid-argument";

export class TimeSeriesError extends Error {
  readonly code: TimeSeriesErrorCode;
  constructor(code: TimeSeriesErrorCode, message: string) {
    super(message);
    this.name = "TimeSeriesError";
    this.code = code;
  }
}

/** Aligns a timestamp to the start of its bucket. */
export function alignedStart(timestamp: number, bucketMs: number, originMs = 0): number {
  if (bucketMs <= 0) return timestamp;
  return Math.floor((timestamp - originMs) / bucketMs) * bucketMs + originMs;
}