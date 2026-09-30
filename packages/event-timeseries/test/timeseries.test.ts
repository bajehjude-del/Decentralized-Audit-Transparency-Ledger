import assert from "node:assert/strict";
import test from "node:test";

import {
  TimeSeriesStore,
  ContinuousAggregate,
  MaterializedView,
  TimeSeriesError,
  alignedStart,
  applyRetention,
  compressSeries,
  decompressSeries,
  defaultTiers,
  downsample,
  lttb,
  tierIndexFor,
  validateTiers,
} from "../src/index.ts";
import type { TimeSeriesEvent } from "../src/index.ts";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function mk(timestamp: number, value: number, stream = "gas"): TimeSeriesEvent {
  return { timestamp, stream, value };
}

function values(events: readonly Pick<TimeSeriesEvent, "timestamp" | "value">[]): number[] {
  return events.map((event) => event.value);
}

test("alignedStart snaps timestamps to their bucket and honours an origin", () => {
  assert.equal(alignedStart(0, 1000), 0);
  assert.equal(alignedStart(1500, 1000), 1000);
  assert.equal(alignedStart(2500, 1000), 2000);
  assert.equal(alignedStart(1500, 1000, 500), 1500);
});

test("downsample collapses each bucket to one representative point", () => {
  const events = [
    mk(0, 2),
    mk(100, 4),
    mk(200, 6),
    mk(1000, 1),
    mk(1400, 3),
  ];
  const avg = downsample(events, 1000, "avg");
  assert.deepEqual(values(avg), [4, 2]);
  assert.deepEqual(avg.map((event) => event.timestamp), [0, 1000]);
  assert.equal(avg[0].stream, "gas");

  assert.deepEqual(values(downsample(events, 1000, "sum")), [12, 4]);
  assert.deepEqual(values(downsample(events, 1000, "count")), [3, 2]);
  assert.deepEqual(values(downsample(events, 1000, "min")), [2, 1]);
  assert.deepEqual(values(downsample(events, 1000, "max")), [6, 3]);
  assert.deepEqual(values(downsample(events, 1000, "last")), [6, 3]);
  assert.deepEqual(downsample([], 1000, "avg"), []);
});

test("downsample rejects a non-positive bucket or a non-bucket method", () => {
  assert.throws(
    () => downsample([mk(0, 1)], 0, "avg"),
    (error: unknown) => error instanceof TimeSeriesError && error.code === "invalid-argument"
  );
  assert.throws(
    () => downsample([mk(0, 1)], 1000, "lttb"),
    (error: unknown) => error instanceof TimeSeriesError && error.code === "invalid-argument"
  );
});

test("lttb keeps the endpoints and reduces to the requested threshold", () => {
  const events = Array.from({ length: 200 }, (_, i) => mk(i * 1000, Math.sin(i / 10)));
  const sampled = lttb(events, 12);
  assert.equal(sampled.length, 12);
  assert.deepEqual(
    [sampled[0].timestamp, sampled[sampled.length - 1].timestamp],
    [events[0].timestamp, events[199].timestamp]
  );
});

test("lttb returns original points when the threshold is large or two", () => {
  const events = [mk(0, 1), mk(1000, 2), mk(2000, 3)];
  assert.equal(lttb(events, 10).length, 3);
  const two = lttb(events, 2);
  assert.equal(two.length, 2);
  assert.equal(two[0].timestamp, 0);
  assert.equal(two[1].timestamp, 2000);
  assert.equal(lttb([], 2).length, 0);
});

test("lttb picks only actual observations (shape is preserved exactly)", () => {
  const events = Array.from({ length: 50 }, (_, i) => mk(i * 100, 100 + i * 2));
  const sampled = lttb(events, 8);
  const original = new Set(events.map((event) => `${event.timestamp}:${event.value}`));
  for (const event of sampled) {
    assert.equal(original.has(`${event.timestamp}:${event.value}`), true);
  }
});

test("compression round-trips integer, float, and repeated values exactly", () => {
  const integer = Array.from({ length: 1000 }, (_, i) => mk(i * 1000, i + 1));
  const floats = Array.from({ length: 250 }, (_, i) => mk(i * 100, ((i * 7) % 13) * 0.75 - 4.125));
  const runs = Array.from({ length: 500 }, (_, i) => mk(i * 1000, 42));
  const mixed = [...integer, ...floats, ...runs].sort((a, b) => a.timestamp - b.timestamp);

  for (const series of [integer, floats, runs, mixed]) {
    const encoded = compressSeries(series);
    const restored = decompressSeries(encoded.bytes, "gas");
    assert.deepEqual(
      restored.map((event) => [event.timestamp, event.value]),
      series.map((event) => [event.timestamp, event.value])
    );
    assert.equal(restored.every((event) => event.stream === "gas"), true);
  }
});

test("compression shrinks constant and regular series", () => {
  const runs = Array.from({ length: 10_000 }, (_, i) => mk(i * 1000, 7));
  const encoded = compressSeries(runs);
  assert.equal(encoded.count, 10_000);
  assert.equal(encoded.stats.ratio > 3, true, `expected a real compression ratio, got ${encoded.stats.ratio}`);

  const every = compressSeries(Array.from({ length: 10_000 }, (_, i) => mk(i * 1000, i)));
  assert.equal(every.stats.ratio > 2, true);
  assert.equal(encoded.stats.bytesOut < every.stats.bytesOut, true, "identical values compress smaller");
});

test("compression rejects a truncated series", () => {
  const encoded = compressSeries([mk(0, 1), mk(1000, 2)]);
  const truncated = encoded.bytes.slice(0, encoded.bytes.length - 1);
  assert.throws(
    () => decompressSeries(truncated),
    (error: unknown) => error instanceof TimeSeriesError
  );
});

test("tiers classify an event by how old it is", () => {
  const tiers = defaultTiers();
  assert.equal(tierIndexFor(tiers, 60 * 1000), 0); // an hour -> hot
  assert.equal(tierIndexFor(tiers, DAY - 1), 0);
  assert.equal(tierIndexFor(tiers, DAY), 1); // exactly the hot boundary -> warm
  assert.equal(tierIndexFor(tiers, 2 * DAY), 1);
  assert.equal(tierIndexFor(tiers, 7 * DAY), 2);
  assert.equal(tierIndexFor(tiers, 90 * DAY), 3);
  assert.equal(tierIndexFor(tiers, 3650 * DAY), 3);
});

test("validateTiers rejects duplicate names and non-increasing ages", () => {
  assert.doesNotThrow(() => validateTiers(defaultTiers()));
  assert.throws(
    () => validateTiers([...defaultTiers(), { name: "hot", maxAgeMs: DAY * 2, bucketMs: 0, method: "last", minPoints: 0 }]),
    (error: unknown) => error instanceof TimeSeriesError && error.code === "invalid-argument"
  );
  assert.throws(
    () =>
      validateTiers([
        { name: "a", maxAgeMs: DAY, bucketMs: 0, method: "last", minPoints: 0 },
        { name: "b", maxAgeMs: DAY, bucketMs: 0, method: "last", minPoints: 0 },
      ]),
    (error: unknown) => error instanceof TimeSeriesError
  );
});

test("applyRetention keeps hot raw and downsamples every older tier", () => {
  const tiers = defaultTiers();
  const at = NOW;
  const hot = [mk(at - DAY + 1000, 1), mk(at - 60 * 60 * 1000, 2)];
  const warm = [mk(at - 2 * DAY, 10), mk(at - 2 * DAY + 1000, 12)];
  const cold = [mk(at - 30 * DAY, 100), mk(at - 30 * DAY + 500, 104)];
  const archive = Array.from({ length: 20 }, (_, i) => mk(at - (400 + i) * DAY, i));

  const result = applyRetention([...hot, ...warm, ...cold, ...archive], tiers, at);

  assert.equal(result.hot.length, 2);
  assert.deepEqual(
    values(result.hot).sort((a, b) => a - b),
    [1, 2]
  );
  const byTier = new Map(result.tiered.map((entry) => [entry.tierIndex, entry.points]));
  assert.equal(byTier.get(1)?.length, 1, "warm collapses its window to an average");
  assert.equal(byTier.get(1)?.[0].value, 11);
  assert.equal(byTier.get(2)?.length, 1, "cold collapses its window to an average");
  assert.equal(byTier.get(2)?.[0].value, 102);
  assert.equal((byTier.get(3) as unknown as { length: number }).length, 20, "archive keeps points under the lttb cap");
});

test("a continuous aggregate materializes completed buckets only on refresh", () => {
  let clock = NOW;
  const agg = new ContinuousAggregate([{ stream: "gas", kind: "sum", bucketMs: 1000 }], {
    now: () => clock,
  });

  agg.ingest(mk(0, 1));
  clock = 500;
  agg.ingest(mk(500, 2));
  clock = 900;
  agg.ingest(mk(1000, 3));
  assert.deepEqual(agg.query("gas"), [], "open bucket is not yet materialized");

  const first = agg.refresh(1000);
  assert.equal(first.materialized, 1);
  assert.equal(first.pending, 1, "the second bucket is still open");
  const buckets = agg.query("gas");
  assert.equal(buckets.length, 1);
  assert.deepEqual([buckets[0].start, buckets[0].end, buckets[0].value, buckets[0].count], [0, 1000, 3, 2]);
  assert.equal(agg.watermarkOf("gas", "sum", 1000), 1000);

  agg.ingest(mk(1500, 4));
  const second = agg.refresh(2000);
  assert.equal(second.materialized, 1);
  assert.deepEqual(
    agg.query("gas").map((bucket) => bucket.value),
    [3, 7]
  );
  assert.equal(agg.watermarkOf("gas", "sum", 1000), 2000);
});

test("a continuous aggregate supports every aggregate kind", () => {
  const kinds = ["sum", "avg", "min", "max", "count", "last"] as const;
  const specs = kinds.map((kind) => ({ stream: "meter", kind, bucketMs: 1000 }));
  const agg = new ContinuousAggregate(specs);
  agg.ingestMany([mk(0, 5, "meter"), mk(500, 3, "meter"), mk(900, 9, "meter")]);
  agg.refresh(2500);
  const byKind = new Map(agg.query("meter").map((bucket) => [bucket.kind, bucket.value]));
  assert.equal(byKind.get("sum"), 17, "5 + 3 + 9");
  assert.equal(byKind.get("avg"), 5.666666666666667);
  assert.equal(byKind.get("min"), 3);
  assert.equal(byKind.get("max"), 9);
  assert.equal(byKind.get("count"), 3);
  assert.equal(byKind.get("last"), 9);
});

test("continuous aggregates are independent per stream and window", () => {
  const agg = new ContinuousAggregate([
    { stream: "a", kind: "avg", bucketMs: 1000 },
    { stream: "b", kind: "max", bucketMs: 2000 },
  ]);
  agg.ingest(mk(0, 10, "a"));
  agg.ingest(mk(0, 99, "b"));
  agg.refresh(5000);
  assert.equal(agg.query("a")[0].value, 10);
  assert.equal(agg.query("b")[0].value, 99);
  assert.deepEqual(agg.query("c"), []);
});

test("a materialized view rebuilds from a snapshot and refreshes incrementally", () => {
  let clock = NOW;
  const view = new MaterializedView({ name: "hourly_max", stream: "gas", kind: "max", bucketMs: 1000 }, { now: () => clock });

  view.ingest(mk(0, 5));
  clock = 400;
  view.ingest(mk(400, 9));
  clock = 1500;
  view.refresh();
  assert.deepEqual(view.query().map((bucket) => bucket.value), [9]);
  assert.equal(view.query(0, 1000).length, 1);
  assert.equal(view.query(3000).length, 0);
});

test("a materialized view can be fully rebuilt (resampled) from raw events", () => {
  const view = new MaterializedView({ name: "summary", stream: "evt", kind: "sum", bucketMs: 1000 });
  const snapshot = [mk(0, 1, "evt"), mk(200, 2, "evt"), mk(1000, 3, "evt"), mk(1800, 4, "evt"), mk(2000, 5, "evt")];
  const count = view.rebuild(snapshot);
  assert.equal(count, 3);
  const buckets = view.query();
  assert.deepEqual(
    buckets.map((bucket) => bucket.value),
    [3, 7, 5]
  );
  assert.deepEqual(buckets.map((bucket) => bucket.count), [2, 2, 1]);
});

test("the store ingests, maintains retention tiers, and still answers queries", () => {
  let clock = NOW;
  const store = new TimeSeriesStore({ now: () => clock });

  const hotEvents = [mk(NOW - 60 * 60 * 1000, 1), mk(NOW - 60 * 60 * 1000 + 100, 2)];
  const warmEvents = [mk(NOW - 2 * DAY, 10), mk(NOW - 2 * DAY, 12)];
  const coldEvents = [mk(NOW - 30 * DAY, 100), mk(NOW - 30 * DAY, 104)];
  const archiveEvents = [mk(NOW - 400 * DAY, 1000), mk(NOW - (400 * DAY + DAY), 2000)];
  store.ingestMany([...hotEvents, ...warmEvents, ...coldEvents, ...archiveEvents]);

  const raw = store.query("gas");
  assert.equal(raw.count, 8);
  assert.deepEqual(store.stats(), {
    streams: 1,
    hotPoints: 8,
    tieredPoints: 0,
    totalPoints: 8,
    perTier: { hot: 0, warm: 0, cold: 0, archive: 0 },
  });

  const report = store.maintain(NOW);
  assert.equal(report.processed, 8);
  assert.equal(report.keptHot, 2);
  const tieredLengths = Object.fromEntries(report.tiered.map((entry) => [entry.name, entry.points]));
  assert.equal(tieredLengths.warm, 1, "two warm points share a window and collapse to their average");
  assert.equal(tieredLengths.cold, 1);
  assert.equal(tieredLengths.archive, 2);

  const stats = store.stats();
  assert.equal(stats.hotPoints, 2);
  assert.equal(stats.tieredPoints, 4);
  assert.equal(stats.totalPoints, 6);

  const warmStart = alignedStart(NOW - 2 * DAY, 5 * 60 * 1000);
  const warmQuery = store.query("gas", warmStart, warmStart + 1);
  assert.equal(warmQuery.count, 1);
  assert.equal(warmQuery.points[0].value, 11, "the warm average of 10 and 12");
});

test("maintain is idempotent: demoted points are not re-examined", () => {
  const store = new TimeSeriesStore();
  store.ingestMany([mk(NOW - 2 * DAY, 5), mk(NOW - 2 * DAY, 7)]);
  const first = store.maintain(NOW);
  const second = store.maintain(NOW);
  assert.equal(first.tieredPoints, 1);
  assert.equal(second.tieredPoints, 0);
  assert.equal(second.keptHot, 0);
  assert.equal(store.stats().totalPoints, 1);
});

test("aggregated queries collapse raw points into aligned buckets", () => {
  const store = new TimeSeriesStore();
  store.ingestMany([mk(0, 1), mk(100, 2), mk(1000, 4), mk(1100, 6)]);
  const sum = store.query("gas", 0, 5000, { aggregate: { kind: "sum", bucketMs: 1000 } });
  assert.deepEqual(
    sum.points.map((point) => point.value),
    [3, 10]
  );
  const avg = store.query("gas", 0, 5000, { aggregate: { kind: "avg", bucketMs: 1000 } });
  assert.deepEqual(
    avg.points.map((point) => point.value),
    [1.5, 5]
  );
});

test("streams can be exported and re-imported losslessly", () => {
  const source = new TimeSeriesStore();
  const events = Array.from({ length: 500 }, (_, i) => mk(i * 1000, (i % 7) * 0.5));
  source.ingestMany(events);
  const encoded = source.exportStream("gas");
  assert.equal(encoded.count, 500);
  assert.equal(encoded.stats.ratio > 1, true);

  const target = new TimeSeriesStore();
  assert.equal(target.importStream(encoded, "gas"), 500);
  assert.deepEqual(
    target.query("gas").points,
    source.query("gas").points
  );
});

test("exporting a stream that never existed reports unknown-stream", () => {
  const store = new TimeSeriesStore();
  assert.throws(
    () => store.exportStream("missing"),
    (error: unknown) => error instanceof TimeSeriesError && error.code === "unknown-stream"
  );
});