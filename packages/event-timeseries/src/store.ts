/**
 * Time-series store for contract events (#430)
 *
 * Wires retention tiers, automatic downsampling, on-the-fly aggregation, and
 * lossless compression around raw and tiered series. Hot events stay raw;
 * older data is demoted into progressively coarser, sampled tiers.
 */

import type { AggregateKind, RetentionTier, TimeSeriesEvent } from "./types.ts";
import { TimeSeriesError } from "./types.ts";
import { downsample } from "./downsample.ts";
import { compressSeries, decompressSeries, type EncodedSeries } from "./compress.ts";
import { applyRetention, defaultTiers, validateTiers } from "./retention.ts";

export interface TimeSeriesStoreOptions {
  tiers?: readonly RetentionTier[];
  now?: () => number;
}

export interface StoreQueryOptions {
  /** Aggregate the returned points into aligned buckets. */
  aggregate?: { kind: AggregateKind; bucketMs: number };
}

export interface StoreQueryResult {
  stream: string;
  /** Points in [from, to), ascending. Aggregated if requested. */
  points: Array<{ timestamp: number; value: number }>;
  count: number;
}

export interface StoreStats {
  streams: number;
  hotPoints: number;
  tieredPoints: number;
  totalPoints: number;
  perTier: Record<string, number>;
}

export interface MaintenanceReport {
  /** Raw events examined. */
  processed: number;
  /** Events that stayed raw in the hot tier. */
  keptHot: number;
  /** Sampled points written per destination tier. */
  tiered: Array<{ tier: number; name: string; points: number }>;
  /** Total sampled points across tiers. */
  tieredPoints: number;
}

/** In-memory store with tiered retention, downsampling, and compression. */
export class TimeSeriesStore {
  private readonly tiers: readonly RetentionTier[];
  private readonly now: () => number;
  private readonly hot = new Map<string, TimeSeriesEvent[]>();
  private readonly tiered = new Map<string, Map<number, TimeSeriesEvent[]>>();

  constructor(options: TimeSeriesStoreOptions = {}) {
    this.tiers = options.tiers ?? defaultTiers();
    this.now = options.now ?? (() => Date.now());
    validateTiers(this.tiers);
  }

  private ingress(event: TimeSeriesEvent): void {
    const list = this.hot.get(event.stream);
    if (list === undefined) this.hot.set(event.stream, [{ ...event }]);
    else list.push({ ...event });
  }

  /** Appends a raw observation to a stream. */
  ingest(event: TimeSeriesEvent): void {
    this.ingress(event);
  }

  ingestMany(events: readonly TimeSeriesEvent[]): void {
    for (const event of events) this.ingress(event);
  }

  /**
   * Demotes and downsamples events that have outlived the hot tier. Safe to
   * run repeatedly: each raw event is examined exactly once.
   */
  maintain(at = this.now()): MaintenanceReport {
    const all: TimeSeriesEvent[] = [];
    let processed = 0;
    for (const list of this.hot.values()) {
      processed += list.length;
      all.push(...list);
    }

    const result = applyRetention(all, this.tiers, at);
    const report: MaintenanceReport = { processed, keptHot: result.hot.length, tiered: [], tieredPoints: 0 };

    this.hot.clear();
    for (const event of result.hot) this.ingress(event);

    for (const entry of result.tiered) {
      const tier = this.tiers[entry.tierIndex];
      report.tieredPoints += entry.points.length;
      report.tiered.push({ tier: entry.tierIndex, name: tier.name, points: entry.points.length });
      if (entry.points.length === 0) continue;
      const stream = entry.points[0].stream;
      const destination = this.byTierFor(stream, entry.tierIndex);
      for (const point of entry.points) destination.push({ ...point });
    }
    return report;
  }

  private byTierFor(stream: string, tierIndex: number): TimeSeriesEvent[] {
    let streams = this.tiered.get(stream);
    if (streams === undefined) {
      streams = new Map();
      this.tiered.set(stream, streams);
    }
    let list = streams.get(tierIndex);
    if (list === undefined) {
      list = [];
      streams.set(tierIndex, list);
    }
    return list;
  }

  /** Fast query: raw points or pre-aggregated buckets in [from, to). */
  query(stream: string, from = 0, to = Number.POSITIVE_INFINITY, options: StoreQueryOptions = {}): StoreQueryResult {
    const within = this.allPoints(stream).filter(
      (event) => event.timestamp >= from && event.timestamp < to
    );
    if (options.aggregate === undefined) {
      const points = within
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((event) => ({ timestamp: event.timestamp, value: event.value }));
      return { stream, points, count: points.length };
    }
    const { kind, bucketMs } = options.aggregate;
    const bucketed = downsample(within, bucketMs, kind).map((event) => ({
      timestamp: event.timestamp,
      value: event.value,
    }));
    return { stream, points: bucketed, count: bucketed.length };
  }

  private allPoints(stream: string): TimeSeriesEvent[] {
    const points: TimeSeriesEvent[] = [];
    const hotList = this.hot.get(stream);
    if (hotList !== undefined) points.push(...hotList);
    const byTier = this.tiered.get(stream);
    if (byTier !== undefined) {
      for (const list of byTier.values()) points.push(...list);
    }
    return points;
  }

  /** Lossless compressed snapshot of a stream. */
  exportStream(stream: string): EncodedSeries {
    if (!this.hot.has(stream) && !this.tiered.has(stream)) {
      throw new TimeSeriesError("unknown-stream", `no series named ${stream}`);
    }
    return compressSeries(this.allPoints(stream));
  }

  /** Restores a compressed snapshot into the store. */
  importStream(encoded: EncodedSeries, stream = ""): number {
    const restored = decompressSeries(encoded.bytes, stream);
    this.ingestMany(restored);
    return restored.length;
  }

  /** Current store layout for observability. */
  stats(): StoreStats {
    const perTier: Record<string, number> = {};
    for (const tier of this.tiers) perTier[tier.name] = 0;
    let tieredPoints = 0;
    for (const byTier of this.tiered.values()) {
      for (const [tierIndex, list] of byTier) {
        perTier[this.tiers[tierIndex].name] = (perTier[this.tiers[tierIndex].name] ?? 0) + list.length;
        tieredPoints += list.length;
      }
    }
    let hotPoints = 0;
    for (const list of this.hot.values()) hotPoints += list.length;
    return {
      streams: new Set([...this.hot.keys(), ...this.tiered.keys()]).size,
      hotPoints,
      tieredPoints,
      totalPoints: hotPoints + tieredPoints,
      perTier,
    };
  }
}