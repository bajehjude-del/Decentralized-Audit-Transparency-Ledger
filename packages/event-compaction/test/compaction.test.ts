import assert from "node:assert/strict";
import test from "node:test";

import {
  CompactionMonitor,
  CompactionScheduler,
  DEFAULT_COMPACTION_POLICY,
  EventCompactor,
  InMemoryEventStore,
  eventKey,
  findProtection,
  selectExpired,
  selectOrphans,
  selectSuperseded,
  selectUnreferencedSegments,
} from "../src/index.ts";
import type { CompactionResult, StoredEvent } from "../src/index.ts";

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function event(overrides: Partial<StoredEvent> & Pick<StoredEvent, "id" | "version">): StoredEvent {
  return {
    contractId: "CTR_A",
    eventType: "audit_log",
    timestamp: NOW - HOUR,
    bytes: 100,
    ...overrides,
  };
}

function versions(count: number, overrides: Partial<StoredEvent> = {}): StoredEvent[] {
  return Array.from({ length: count }, (_unused, index) =>
    event({
      id: `evt-${index + 1}`,
      version: index + 1,
      timestamp: NOW - (count - index) * HOUR,
      ...overrides,
    })
  );
}

test("eventKey scopes supersession to contract and event type", () => {
  assert.equal(eventKey(event({ id: "a", version: 1 })), "CTR_A::audit_log");
  assert.equal(
    eventKey(event({ id: "b", version: 1, contractId: "CTR_B" })),
    "CTR_B::audit_log"
  );
  assert.notEqual(
    eventKey(event({ id: "c", version: 1, eventType: "payment" })),
    eventKey(event({ id: "d", version: 1 }))
  );
});

test("selectSuperseded keeps the newest retainVersions and flags the rest", () => {
  const policy = { ...DEFAULT_COMPACTION_POLICY, retainVersions: 3 };
  const { superseded, retained } = selectSuperseded(versions(6), policy);
  assert.deepEqual(
    superseded.map((entry) => entry.id),
    ["evt-1", "evt-2", "evt-3"]
  );
  assert.deepEqual(
    retained.map((entry) => entry.id),
    ["evt-4", "evt-5", "evt-6"]
  );
});

test("selectSuperseded never crosses version keys", () => {
  const policy = { ...DEFAULT_COMPACTION_POLICY, retainVersions: 1 };
  const mixed = [
    event({ id: "a-1", version: 1, eventType: "audit_log" }),
    event({ id: "a-2", version: 2, eventType: "audit_log" }),
    event({ id: "b-1", version: 1, eventType: "payment" }),
  ];
  const { superseded, retained } = selectSuperseded(mixed, policy);
  assert.deepEqual(
    superseded.map((entry) => entry.id),
    ["a-1"]
  );
  assert.equal(retained.length, 2);
});

test("findProtection honours the policy toggles in order of severity", () => {
  const policy = DEFAULT_COMPACTION_POLICY;
  assert.equal(findProtection(event({ id: "a", version: 1, legalHold: true }), policy), "legal-hold");
  assert.equal(findProtection(event({ id: "b", version: 1, immutable: true }), policy), "immutable");
  assert.equal(findProtection(event({ id: "c", version: 1, sealed: true }), policy), "sealed");
  assert.equal(findProtection(event({ id: "d", version: 1 }), policy), null);

  const relaxed = { ...policy, honorLegalHold: false, protectImmutable: false };
  assert.equal(findProtection(event({ id: "e", version: 1, legalHold: true }), relaxed), null);
  assert.equal(
    findProtection(event({ id: "f", version: 1, legalHold: true, sealed: true }), relaxed),
    "sealed"
  );
});

test("selectExpired respects maxAgeMs and is disabled when unset", () => {
  const old = event({ id: "old", version: 1, timestamp: NOW - 10 * HOUR });
  const fresh = event({ id: "fresh", version: 2, timestamp: NOW - HOUR });
  const policy = { ...DEFAULT_COMPACTION_POLICY, maxAgeMs: 5 * HOUR };

  assert.deepEqual(
    selectExpired([old, fresh], policy, NOW).map((entry) => entry.id),
    ["old"]
  );
  assert.deepEqual(selectExpired([old, fresh], { ...policy, maxAgeMs: undefined }, NOW), []);
});

test("selectOrphans only flags dangling parents", () => {
  const events = [
    event({ id: "child", version: 1, parentEventId: "missing" }),
    event({ id: "linked", version: 1, parentEventId: "root" }),
    event({ id: "root", version: 1 }),
  ];
  const ids = new Set(["child", "linked", "root"]);
  assert.deepEqual(
    selectOrphans(events, ids).map((entry) => entry.id),
    ["child"]
  );
});

test("selectUnreferencedSegments drops segments with no surviving events", () => {
  const segments = [
    { id: "seg-1", eventIds: ["a", "b"] },
    { id: "seg-2", eventIds: ["c"] },
    { id: "seg-3", eventIds: [] },
  ];
  const remaining = new Set(["a"]);
  assert.deepEqual(selectUnreferencedSegments(segments, remaining), ["seg-2", "seg-3"]);
});

test("compact removes superseded versions and releases empty segments", () => {
  const store = new InMemoryEventStore(versions(5), [
    { id: "seg-1", contractId: "CTR_A", eventIds: ["evt-1", "evt-2"], bytes: 200, createdAt: NOW },
    { id: "seg-2", contractId: "CTR_A", eventIds: ["evt-5"], bytes: 100, createdAt: NOW },
  ]);
  const compactor = new EventCompactor(store, { retainVersions: 2, maxAgeMs: undefined });

  const result = compactor.compact({ now: NOW });

  assert.deepEqual(result.compactedIds, ["evt-1", "evt-2", "evt-3"]);
  assert.deepEqual(result.freedSegments, ["seg-1"]);
  assert.equal(result.reclaimedBytes, 300);
  assert.equal(result.errors.length, 0);
  assert.equal(store.size(), 2);
  assert.equal(store.removals().includes("segment:seg-1"), true);
  assert.deepEqual(
    compactor.latestVersions().map((entry) => entry.id),
    ["evt-5"]
  );
});

test("dry run reports the same removals without mutating the store", () => {
  const store = new InMemoryEventStore(versions(4));
  const compactor = new EventCompactor(store, { retainVersions: 1, maxAgeMs: undefined });

  const dry = compactor.compact({ now: NOW, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.compactedIds, ["evt-1", "evt-2", "evt-3"]);
  assert.equal(store.size(), 4);
  assert.deepEqual(store.removals(), []);

  const real = compactor.compact({ now: NOW });
  assert.deepEqual(real.compactedIds, dry.compactedIds);
  assert.equal(store.size(), 1);
});

test("compaction skips protected events and reports the reason", () => {
  const store = new InMemoryEventStore([
    event({ id: "hold-1", version: 1, legalHold: true }),
    event({ id: "sealed-1", version: 2, sealed: true }),
    event({ id: "free-1", version: 3 }),
  ]);
  const compactor = new EventCompactor(store, { retainVersions: 0, maxAgeMs: undefined });

  const result = compactor.compact({ now: NOW });

  assert.deepEqual(result.compactedIds, ["free-1"]);
  const reasons = new Map(result.skipped.map((skip) => [skip.id, skip.reason]));
  assert.equal(reasons.get("hold-1"), "legal-hold");
  assert.equal(reasons.get("sealed-1"), "sealed");
  assert.equal(store.getEvent("hold-1") !== undefined, true);
});

test("orphaned events are collected and reported ahead of other reasons", () => {
  const store = new InMemoryEventStore([
    event({ id: "orphan", version: 1, parentEventId: "gone" }),
    event({ id: "old", version: 2, timestamp: NOW - 10 * HOUR }),
  ]);
  const compactor = new EventCompactor(store, { retainVersions: 10, maxAgeMs: HOUR });

  const result = compactor.compact({ now: NOW });

  assert.equal(result.compacted.length, 2);
  assert.equal(result.compacted[0].id, "orphan");
  assert.equal(result.compacted[0].reason, "orphaned");
  assert.equal(result.compacted[1].reason, "ttl-expired");
});

test("orphan collection can be disabled by policy", () => {
  const store = new InMemoryEventStore([
    event({ id: "orphan", version: 1, parentEventId: "gone" }),
  ]);
  const compactor = new EventCompactor(store, {
    retainVersions: 10,
    maxAgeMs: undefined,
    collectOrphans: false,
  });

  const result = compactor.compact({ now: NOW });
  assert.deepEqual(result.compactedIds, []);
  assert.equal(store.size(), 1);
});

test("contract scoping restricts the pass and marks the rest out of scope", () => {
  const store = new InMemoryEventStore([
    event({ id: "a-1", version: 1, contractId: "CTR_A" }),
    event({ id: "a-2", version: 2, contractId: "CTR_A" }),
    event({ id: "b-1", version: 1, contractId: "CTR_B" }),
    event({ id: "b-2", version: 2, contractId: "CTR_B" }),
  ]);
  const compactor = new EventCompactor(store, {
    retainVersions: 1,
    maxAgeMs: undefined,
    contracts: ["CTR_A"],
  });

  const result = compactor.compact({ now: NOW });

  assert.deepEqual(result.compactedIds, ["a-1"]);
  assert.equal(result.skipped.some((skip) => skip.id === "b-1" && skip.reason === "out-of-scope"), true);
  assert.equal(store.getEvent("b-1") !== undefined, true);
});

test("estimateReclaimableBytes matches what a pass reclaims", () => {
  const store = new InMemoryEventStore(versions(4));
  const compactor = new EventCompactor(store, { retainVersions: 2, maxAgeMs: undefined });

  assert.equal(compactor.estimateReclaimableBytes(NOW), 200);
  assert.equal(compactor.compact({ now: NOW }).reclaimedBytes, 200);
  assert.equal(compactor.estimateReclaimableBytes(NOW), 0);
});

test("a retained head that is expired or orphaned is still compacted", () => {
  const store = new InMemoryEventStore([
    event({ id: "retained", version: 1, timestamp: NOW - 10 * HOUR }),
  ]);
  const compactor = new EventCompactor(store, { retainVersions: 10, maxAgeMs: HOUR });

  const result = compactor.compact({ now: NOW });

  assert.deepEqual(result.compactedIds, ["retained"]);
  assert.deepEqual(result.compacted[0].reason, "ttl-expired");
  assert.equal(result.skipped.some((skip) => skip.id === "retained"), false);
});

test("store failures are surfaced as errors instead of throwing", () => {
  const store = new InMemoryEventStore(versions(3));
  const failing = {
    listEvents: () => store.listEvents(),
    getEvent: (id: string) => store.getEvent(id),
    removeEvents: () => {
      throw new Error("disk offline");
    },
    listSegments: () => store.listSegments(),
    removeSegments: (ids: string[]) => store.removeSegments(ids),
  };
  const compactor = new EventCompactor(failing, { retainVersions: 1, maxAgeMs: undefined });

  const result = compactor.compact({ now: NOW });

  assert.equal(result.compactedIds.length, 2);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /disk offline/);
});

test("scheduler runs on its interval and stops at maxRuns", () => {
  const store = new InMemoryEventStore(versions(3));
  const compactor = new EventCompactor(store, { retainVersions: 1, maxAgeMs: undefined });
  const timers: Array<{ delayMs: number; handler: () => void }> = [];
  const scheduler = new CompactionScheduler(compactor, {
    intervalMs: 1000,
    maxRuns: 2,
    setTimer: (handler, delayMs) => {
      timers.push({ delayMs, handler });
      return timers.length;
    },
    clearTimer: () => undefined,
  });

  const observed: CompactionResult[] = [];
  scheduler.onRun((result) => observed.push(result));

  scheduler.start(NOW);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 1000);
  assert.equal(scheduler.getStatus().nextRunAt, NOW + 1000);

  timers[0].handler();
  assert.equal(observed.length, 1);
  assert.equal(store.size(), 1);
  assert.equal(scheduler.getStatus().runs, 1);
  assert.equal(scheduler.getStatus().lastResult?.compactedIds.length, 2);

  scheduler.tick(NOW + 1000);
  assert.equal(observed.length, 2);
  assert.equal(scheduler.getStatus().running, false, "scheduler stops once maxRuns is reached");
  assert.equal(scheduler.getStatus().nextRunAt, null);
});

test("scheduler stop is idempotent and clears the pending timer", () => {
  const cleared: unknown[] = [];
  const scheduler = new CompactionScheduler(
    new EventCompactor(new InMemoryEventStore(), { retainVersions: 1, maxAgeMs: undefined }),
    {
      intervalMs: 500,
      setTimer: () => "handle",
      clearTimer: (handle) => cleared.push(handle),
    }
  );

  scheduler.start(NOW);
  scheduler.stop();
  scheduler.stop();

  assert.deepEqual(cleared, ["handle"]);
  assert.equal(scheduler.getStatus().running, false);
});

test("a throwing listener does not break the schedule", () => {
  const compactor = new EventCompactor(new InMemoryEventStore(), {
    retainVersions: 1,
    maxAgeMs: undefined,
  });
  const scheduler = new CompactionScheduler(compactor, { maxRuns: 1 });
  let reached = false;

  scheduler.onRun(() => {
    throw new Error("listener exploded");
  });
  scheduler.onRun(() => {
    reached = true;
  });

  const result = scheduler.runOnce({ now: NOW });
  assert.equal(reached, true);
  assert.equal(result.runId.startsWith("cmp-"), true);
});

test("monitor aggregates metrics across runs and breaks down by reason", () => {
  const store = new InMemoryEventStore([
    event({ id: "orphan", version: 1, parentEventId: "gone" }),
    event({ id: "old-1", version: 2, timestamp: NOW - 10 * HOUR }),
    event({ id: "old-2", version: 3, timestamp: NOW - 10 * HOUR }),
  ]);
  const compactor = new EventCompactor(store, { retainVersions: 10, maxAgeMs: HOUR });
  const monitor = new CompactionMonitor();

  const result = compactor.compact({ now: NOW });
  monitor.record(result);

  const metrics = monitor.snapshot();
  assert.equal(metrics.runs, 1);
  assert.equal(metrics.failures, 0);
  assert.equal(metrics.eventsCompacted, 3);
  assert.equal(metrics.bytesReclaimed, 300);
  assert.equal(metrics.byReason.orphaned, 1);
  assert.equal(metrics.byReason["ttl-expired"], 2);
  assert.equal(metrics.lastRunAt, result.completedAt);
  assert.deepEqual(monitor.evaluate(NOW), []);
});

test("monitor raises alerts for failures, slow runs, and a stalled schedule", () => {
  const monitor = new CompactionMonitor({
    maxFailures: 2,
    maxDurationMs: 10,
    maxRunIntervalMs: HOUR,
  });
  const base: CompactionResult = {
    runId: "cmp-1",
    startedAt: NOW,
    completedAt: NOW + 100,
    dryRun: false,
    compacted: [],
    compactedIds: [],
    freedSegments: [],
    reclaimedBytes: 0,
    skipped: [],
    errors: ["disk offline"],
    durationMs: 100,
  };

  monitor.record(base);
  monitor.record({ ...base, runId: "cmp-2" });
  const codes = monitor.evaluate(NOW).map((alert) => alert.code);

  assert.equal(codes.includes("repeated-failures"), true);
  assert.equal(codes.includes("slow-compaction"), true);
  assert.equal(codes.includes("low-reclaim"), true);
  assert.equal(
    monitor.evaluate(NOW + 10 * HOUR).some((alert) => alert.code === "stalled-scheduler"),
    true
  );
  assert.equal(monitor.snapshot().failures, 2);
});

test("monitor renders Prometheus exposition text", () => {
  const store = new InMemoryEventStore(versions(2));
  const compactor = new EventCompactor(store, { retainVersions: 1, maxAgeMs: undefined });
  const monitor = new CompactionMonitor();
  monitor.record(compactor.compact({ now: NOW }));

  const text = monitor.toPrometheus();
  assert.match(text, /event_compaction_runs_total 1/);
  assert.match(text, /event_compaction_events_total 1/);
  assert.match(text, /event_compaction_bytes_reclaimed_total 100/);
  assert.match(text, /event_compaction_events_by_reason_total\{reason="superseded"\} 1/);
});
