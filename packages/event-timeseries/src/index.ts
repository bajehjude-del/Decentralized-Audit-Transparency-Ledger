/**
 * Contract event time-series optimization (#430)
 */

export type {
  TimeSeriesEvent,
  DownsampleMethod,
  AggregateKind,
  RetentionTier,
  AggregateBucket,
  ViewDefinition,
} from "./types.ts";
export { TimeSeriesError, alignedStart } from "./types.ts";
export type { TimeSeriesErrorCode } from "./types.ts";

export { downsample, lttb } from "./downsample.ts";
export type { DownsampledTier } from "./downsample.ts";

export { compressSeries, decompressSeries } from "./compress.ts";
export type { CompressionStats, EncodedSeries } from "./compress.ts";

export { defaultTiers, validateTiers, tierIndexFor, applyRetention } from "./retention.ts";
export type { RetentionResult } from "./retention.ts";

export { ContinuousAggregate, MaterializedView } from "./aggregates.ts";
export type { ContinuousAggregateSpec, AggregateRefreshReport } from "./aggregates.ts";

export { TimeSeriesStore } from "./store.ts";
export type {
  TimeSeriesStoreOptions,
  StoreQueryOptions,
  StoreQueryResult,
  StoreStats,
  MaintenanceReport,
} from "./store.ts";