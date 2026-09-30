# @audit-ledger/event-compaction

Contract event compaction and garbage collection for the Audit Ledger. Removes
superseded event versions, expires aged data, collects orphaned records and empty
segments, and reports on storage health.

Zero runtime dependencies. Requires Node.js 22.6 or newer (the tests run the
TypeScript sources directly).

## Usage

```ts
import { CompactionMonitor, CompactionScheduler, EventCompactor, InMemoryEventStore } from "@audit-ledger/event-compaction";

const store = new InMemoryEventStore(events, segments);
const compactor = new EventCompactor(store, {
  retainVersions: 5,          // keep the 5 newest versions per contract + event type
  maxAgeMs: 90 * 24 * 3600e3, // drop anything older than 90 days
  honorLegalHold: true,       // litigation holds are never touched
});

// Inspect before touching anything.
const reclaimable = compactor.estimateReclaimableBytes();
const preview = compactor.compact({ dryRun: true });

// Real pass, then a recurring schedule.
const monitor = new CompactionMonitor();
const scheduler = new CompactionScheduler(compactor, { intervalMs: 6 * 3600e3 });
scheduler.onRun((result) => {
  monitor.record(result);
  for (const alert of monitor.evaluate()) {
    console.warn(alert.code, alert.message);
  }
});
scheduler.start();
```

## What a pass does

1. **Select** — every event is evaluated against the policy. Removal candidates
   are unioned, so an event that is both orphaned and expired is removed once and
   reported under the more descriptive reason.
2. **Protect** — `immutable`, `sealed` and `legalHold` events veto every reason.
   Events outside the policy's contract scope are left alone.
3. **Delete** — candidates are removed from the store.
4. **Release** — segments left with no surviving events are freed.

Every pass returns a `CompactionResult` listing what was removed, what was
skipped and why, the bytes reclaimed, and any errors. Passes never throw: a store
failure is reported in `result.errors`.

## Policy

| Option | Default | Effect |
| --- | --- | --- |
| `retainVersions` | `5` | Newest versions kept per `contractId` + `eventType` |
| `maxAgeMs` | 365 days | Age cutoff; omit to disable TTL compaction |
| `protectImmutable` | `true` | Never remove on-chain sealed events |
| `protectSealed` | `true` | Never remove archived buckets |
| `honorLegalHold` | `true` | Never remove events under litigation hold |
| `collectOrphans` | `true` | Remove events whose `parentEventId` no longer resolves |
| `collectUnreferencedSegments` | `true` | Remove segments with no surviving events |
| `contracts` | all | Restrict the pass to specific contracts |

## Monitoring

`CompactionMonitor` folds pass history into metrics (`snapshot()`), raises alerts
when the posture is unhealthy (`evaluate()`), and renders Prometheus exposition
text (`toPrometheus()`):

```
event_compaction_runs_total
event_compaction_failures_total
event_compaction_events_total
event_compaction_bytes_reclaimed_total
event_compaction_last_duration_ms
event_compaction_events_by_reason_total{reason="superseded|ttl-expired|orphaned"}
```

Alert codes: `repeated-failures` (critical), `stalled-scheduler` (critical),
`slow-compaction` (warning), `low-reclaim` (info).

## Tests

```sh
npm test
```

## Issue

Implements [#427](https://github.com/daddygokings-art/Decentralized-Audit-Transparency-Ledger/issues/427)
— contract event compaction and garbage collection.
