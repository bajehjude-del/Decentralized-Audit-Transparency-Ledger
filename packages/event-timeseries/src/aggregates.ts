/**
 * Continuous aggregates and materialized views for contract event series (#430)
 *
 * A continuous aggregate is defined once per (stream, kind, bucket); as events
 * land, the bucket currently being filled is kept open, and `refresh()` closes
 * every bucket that has ended, upserting it into the materialized set. Reads
 * then hit precomputed buckets instead of rescanning raw events.
 *
 * A materialized view binds one such aggregate to a name and can be rebuilt
 * from a raw snapshot or refreshed incrementally.
 */

import type { AggregateBucket, AggregateKind, TimeSeriesEvent, ViewDefinition } from "./types.ts";
import { alignedStart, TimeSeriesError } from "./types.ts";

export interface ContinuousAggregateSpec {
  stream: string;
  kind: AggregateKind;
  bucketMs: number;
  /** Bucket alignment offset; 0 aligns to the epoch. */
  originMs?: number;
}

export interface AggregateRefreshReport {
  /** Buckets closed and materialized during this refresh. */
  materialized: number;
  /** Aggregates with a bucket still open at the refresh horizon. */
  pending: number;
  through: number;
}

interface PartialBucket {
  start: number;
  sum: number;
  count: number;
  min: number;
  max: number;
  last: number;
}

function specKey(stream: string, kind: AggregateKind, bucketMs: number): string {
  return `${stream}~${kind}~${bucketMs}`;
}

function startPartial(bucketStart: number, value: number): PartialBucket {
  return { start: bucketStart, sum: value, count: 1, min: value, max: value, last: value };
}

function accumulate(partial: PartialBucket, value: number): void {
  partial.sum += value;
  partial.count += 1;
  partial.min = Math.min(partial.min, value);
  partial.max = Math.max(partial.max, value);
  partial.last = value;
}

function valueFrom(partial: PartialBucket, kind: AggregateKind): number {
  if (kind === "sum") return partial.sum;
  if (kind === "avg") return partial.sum / partial.count;
  if (kind === "min") return partial.min;
  if (kind === "max") return partial.max;
  if (kind === "count") return partial.count;
  return partial.last;
}

/** Continuously maintained aggregate over one or more series. */
export class ContinuousAggregate {
  private readonly specs: ContinuousAggregateSpec[];
  private readonly now: () => number;
  private readonly byStream = new Map<string, ContinuousAggregateSpec[]>();
  private readonly open = new Map<string, Map<number, PartialBucket>>();
  private readonly completed = new Map<string, Map<number, AggregateBucket>>();
  private readonly watermark = new Map<string, number>();

  constructor(specs: readonly ContinuousAggregateSpec[], options: { now?: () => number } = {}) {
    this.specs = specs.map((spec) => ({ ...spec, originMs: spec.originMs ?? 0 }));
    this.now = options.now ?? (() => Date.now());
    for (const spec of this.specs) {
      if (!(spec.bucketMs > 0)) {
        throw new TimeSeriesError("invalid-argument", `bucketMs must be positive, got ${spec.bucketMs}`);
      }
      const list = this.byStream.get(spec.stream);
      if (list === undefined) this.byStream.set(spec.stream, [spec]);
      else list.push(spec);
    }
  }

  /** Routes an event into the open partial of every aggregate for its stream. */
  ingest(event: TimeSeriesEvent): void {
    const specs = this.byStream.get(event.stream);
    if (specs === undefined) return;
    for (const spec of specs) {
      const key = specKey(spec.stream, spec.kind, spec.bucketMs);
      const start = alignedStart(event.timestamp, spec.bucketMs, spec.originMs);
      let byStart = this.open.get(key);
      if (byStart === undefined) {
        byStart = new Map();
        this.open.set(key, byStart);
      }
      const current = byStart.get(start);
      if (current === undefined) byStart.set(start, startPartial(start, event.value));
      else accumulate(current, event.value);
    }
  }

  ingestMany(events: readonly TimeSeriesEvent[]): void {
    for (const event of events) this.ingest(event);
  }

  private finalize(spec: ContinuousAggregateSpec, partial: PartialBucket): void {
    const key = specKey(spec.stream, spec.kind, spec.bucketMs);
    const bucket: AggregateBucket = {
      start: partial.start,
      end: partial.start + spec.bucketMs,
      stream: spec.stream,
      kind: spec.kind,
      bucketMs: spec.bucketMs,
      value: valueFrom(partial, spec.kind),
      count: partial.count,
    };
    let byStart = this.completed.get(key);
    if (byStart === undefined) {
      byStart = new Map();
      this.completed.set(key, byStart);
    }
    byStart.set(bucket.start, bucket);
    this.watermark.set(key, Math.max(this.watermark.get(key) ?? 0, bucket.end));
  }

  /**
   * Closes and materializes every bucket that has ended at or before
   * `through` (default: the injected clock). Returns the refresh report.
   */
  refresh(through = this.now()): AggregateRefreshReport {
    let materialized = 0;
    let pending = 0;
    for (const spec of this.specs) {
      const key = specKey(spec.stream, spec.kind, spec.bucketMs);
      const byStart = this.open.get(key);
      if (byStart === undefined) {
        pending += 1;
        continue;
      }
      for (const [start, partial] of byStart) {
        if (start + spec.bucketMs <= through) {
          this.finalize(spec, partial);
          byStart.delete(start);
          materialized += 1;
        }
      }
      if (byStart.size > 0) pending += 1;
    }
    return { materialized, pending, through };
  }

  /** Completed buckets for a stream in [from, to), ordered by start. */
  query(stream: string, from?: number, to?: number): AggregateBucket[] {
    const result: AggregateBucket[] = [];
    for (const key of this.completed.keys()) {
      if (!key.startsWith(`${stream}~`)) continue;
      for (const bucket of this.completed.get(key)?.values() ?? []) {
        if (from !== undefined && bucket.start < from) continue;
        if (to !== undefined && bucket.end > to) continue;
        result.push(bucket);
      }
    }
    return result.sort((a, b) => a.start - b.start);
  }

  /** Exclusive end of the newest completed bucket for an aggregate. */
  watermarkOf(stream: string, kind: AggregateKind, bucketMs: number): number {
    return this.watermark.get(specKey(stream, kind, bucketMs)) ?? 0;
  }
}

/** A named, refreshable materialized view over one series. */
export class MaterializedView {
  readonly definition: ViewDefinition;
  private readonly spec: ContinuousAggregateSpec;
  private readonly now: () => number;
  private aggregate: ContinuousAggregate;

  constructor(definition: ViewDefinition, options: { now?: () => number } = {}) {
    this.definition = { ...definition };
    this.now = options.now ?? (() => Date.now());
    this.spec = {
      stream: definition.stream,
      kind: definition.kind,
      bucketMs: definition.bucketMs,
    };
    this.aggregate = new ContinuousAggregate([this.spec], { now: this.now });
  }

  /** Feeds new raw points into the view for later `refresh()`. */
  ingest(event: TimeSeriesEvent): void {
    this.aggregate.ingest(event);
  }

  ingestMany(events: readonly TimeSeriesEvent[]): void {
    this.aggregate.ingestMany(events);
  }

  /** Closes and materializes every ended bucket. Returns the report. */
  refresh(through?: number): AggregateRefreshReport {
    return this.aggregate.refresh(through ?? this.now());
  }

  /** Completed buckets in [from, to), ordered by start. */
  query(from?: number, to?: number): AggregateBucket[] {
    return this.aggregate.query(this.definition.stream, from, to);
  }

  /** Full rebuild (resample) from a raw snapshot. Returns materialized buckets. */
  rebuild(events: readonly TimeSeriesEvent[]): number {
    this.aggregate = new ContinuousAggregate([this.spec], { now: this.now });
    this.aggregate.ingestMany(events);
    this.aggregate.refresh(Number.POSITIVE_INFINITY);
    return this.query().length;
  }
}