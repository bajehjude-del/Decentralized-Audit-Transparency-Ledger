/**
 * Retention tiers for contract event series (#430)
 *
 * Every tier declares how old a point may become before it is promoted to the
 * next, coarser tier. Hot tiers keep raw events; later tiers downsample, so
 * storage stays bounded while history is preserved at progressively lower
 * resolution.
 */

import type { RetentionTier, TimeSeriesEvent } from "./types.ts";
import { TimeSeriesError } from "./types.ts";
import { downsampleWith, type DownsampledTier } from "./downsample.ts";

/** A reasonable default ladder: one day hot, one week warm, 90 days cold. */
export function defaultTiers(): RetentionTier[] {
  const DAY = 24 * 60 * 60 * 1000;
  return [
    { name: "hot", maxAgeMs: DAY, bucketMs: 0, method: "last", minPoints: 0 },
    { name: "warm", maxAgeMs: 7 * DAY, bucketMs: 5 * 60 * 1000, method: "avg", minPoints: 0 },
    { name: "cold", maxAgeMs: 90 * DAY, bucketMs: 60 * 60 * 1000, method: "avg", minPoints: 0 },
    { name: "archive", maxAgeMs: Number.POSITIVE_INFINITY, bucketMs: DAY, method: "lttb", minPoints: 1024 },
  ];
}

/** Validates a tier list: names unique and maxAgeMs strictly increasing. */
export function validateTiers(tiers: readonly RetentionTier[]): void {
  const seen = new Set<string>();
  let previousAgeMs = -1;
  for (const tier of tiers) {
    if (seen.has(tier.name)) {
      throw new TimeSeriesError("invalid-argument", `duplicate tier name ${tier.name}`);
    }
    if (tier.maxAgeMs <= previousAgeMs) {
      throw new TimeSeriesError(
        "invalid-argument",
        `tier ${tier.name} maxAgeMs must be greater than the previous tier`
      );
    }
    seen.add(tier.name);
    previousAgeMs = tier.maxAgeMs;
  }
}

/**
 * The tier index an event of age `ageMs` belongs to. Semantic: the oldest
 * point promoted to tier i stays there until it outlives tier i's maxAgeMs.
 */
export function tierIndexFor(tiers: readonly RetentionTier[], ageMs: number): number {
  validateTiers(tiers);
  for (let i = 0; i < tiers.length; i++) {
    if (ageMs < tiers[i].maxAgeMs) return i;
  }
  return tiers.length - 1;
}

export interface RetentionResult {
  /** Events young enough to remain raw. */
  hot: TimeSeriesEvent[];
  /** Downsampled points per destination tier, keyed by tier index. */
  tiered: DownsampledTier[];
}

/**
 * Applies the retention policy at `now`: hot points stay raw, and older points
 * are downsampled and bucketed into their tier, oldest tier first.
 */
export function applyRetention(
  events: readonly TimeSeriesEvent[],
  tiers: readonly RetentionTier[],
  now: number
): RetentionResult {
  validateTiers(tiers);
  const hot: TimeSeriesEvent[] = [];
  const tiered: DownsampledTier[] = [];
  const perTier = new Map<number, TimeSeriesEvent[]>();

  for (const event of events) {
    const age = now - event.timestamp;
    const tierIndex = tierIndexFor(tiers, age);
    if (tierIndex === 0) {
      hot.push({ ...event });
    } else {
      const list = perTier.get(tierIndex);
      if (list === undefined) perTier.set(tierIndex, [event]);
      else list.push(event);
    }
  }

  for (const [tierIndex, points] of perTier) {
    const tier = tiers[tierIndex];
    const sampled = downsampleWith(points, tier.method, tier.bucketMs, tier.minPoints);
    tiered.push({ tierIndex, points: sampled });
  }
  return { hot, tiered };
}