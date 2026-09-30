# event-timeseries

Time-series optimization for contract event streams: retention tiers with
automatic downsampling, continuous aggregates / materialized views, and
lossless compression. No database or runtime dependencies.

## What it does

- **Retention tiers** - events age through a ladder (hot raw, warm, cold,
  archive). The hot tier keeps every event; older points are demoted and
  downsampled, so history is preserved at progressively lower resolution.
  Tiers are configurable (`name`, `maxAgeMs`, bucket, method, min points).
- **Downsampling** - bucket-aggregate methods (`avg`, `sum`, `count`, `min`,
  `max`, `last`) and Largest-Triangle-Three-Buckets (`lttb`) for shape-aware
  thinning when a tier exceeds its point cap.
- **Continuous aggregates** - define a `(stream, kind, bucketMs)` aggregate
  once; ingestion fills open buckets and `refresh()` materializes every bucket
  that has ended, so reads hit precomputed buckets instead of rescanning raw
  events.
- **Materialized views** - a named continuous aggregate that can be rebuilt
  (resampled) from a raw snapshot or refreshed incrementally.
- **Compression** - delta-of-delta timestamps, run-length runs, and delta
  integers (with float fallback) pack a series losslessly into a byte string
  ready for export and re-import.
- **Store** - `TimeSeriesStore` wires it all together: ingest, scheduled
  `maintain()`, fast queries (optionally pre-aggregated into buckets),
  `exportStream()` / `importStream()`, and layout stats.

## Usage

```ts
import { TimeSeriesStore, defaultTiers, ContinuousAggregate } from "./src/index.ts";

const store = new TimeSeriesStore({ tiers: defaultTiers() });
store.ingestMany([
  { timestamp: 1_700_000_000_000, stream: "gas", value: 12.5 },
  { timestamp: 1_700_000_001_000, stream: "gas", value: 13.0 },
]);

// Demote events that have outlived the hot tier.
const report = store.maintain();

// Fast pre-aggregated read over any range.
const hourly = store.query("gas", 0, Infinity, { aggregate: { kind: "avg", bucketMs: 3_600_000 } });

// Continuous aggregate with refresh-only materialization.
const agg = new ContinuousAggregate([{ stream: "gas", kind: "sum", bucketMs: 60_000 }]);
agg.ingest({ timestamp: 1_700_000_000_000, stream: "gas", value: 5 });
agg.refresh();
const buckets = agg.query("gas");

// Lossless snapshot for export.
const encoded = store.exportStream("gas");
store.importStream(encoded, "gas");
```

## Retention model

Event age is measured against the `maintain()` clock and mapped to the first
tier whose `maxAgeMs` is greater. Hot events stay raw; every older tier
downsamples its points into aligned buckets. The default ladder keeps one day
of raw data, one week at 5-minute averages, 90 days at hourly averages, and
everything else at daily LTTB samples capped at 1024 points per window.

## Testing

```sh
node --experimental-strip-types --test test/*.test.ts
```

Requires Node 22.6+ (type stripping). No dependencies.