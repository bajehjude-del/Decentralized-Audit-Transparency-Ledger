/**
 * Event Bus Reliability Tests
 *
 * Tests for:
 *   - Concurrent publish + subscribe ordering
 *   - DLQ overflow and requeueing
 *   - Replay correctness with large event logs
 *   - Factory backend selection
 *   - RelayerPublisher integration
 *   - NotifierSubscriber integration
 *   - AnalyticsSubscriber integration
 *   - BridgeSubscriber integration
 *   - EventBusMetricsReporter render output
 *   - Event filtering edge cases
 */

import { InMemoryEventBus } from "../InMemoryEventBus";
import { createEventBus } from "../EventBusFactory";
import { RelayerPublisher, EVENT_TYPES, type RawContractEvent } from "../publishers/RelayerPublisher";
import { NotifierSubscriber, type NotifierLike } from "../subscribers/NotifierSubscriber";
import {
  AnalyticsSubscriber,
  BridgeSubscriber,
  InMemoryAnalyticsSink,
  type BridgeHandler,
  type AnalyticsRecord,
} from "../subscribers/AnalyticsSubscriber";
import { EventBusMetricsReporter } from "../EventBusMetricsReporter";
import type { EventMessage, ContractEventPayload, RelayedEventPayload, SkippedEventPayload, RelayErrorPayload } from "../index";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRawEvent(overrides: Partial<RawContractEvent> = {}): RawContractEvent {
  return {
    index: 1,
    timestamp: Date.now(),
    event_type: "payment",
    submitter: "GADDR123",
    metadata: '{"amount":500}',
    event_hash: "0xdeadbeef",
    ledger_seq: 12345,
    tx_hash: "0xabcdef",
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── RelayerPublisher ──────────────────────────────────────────────────────────

describe("RelayerPublisher", () => {
  let bus: InMemoryEventBus;
  let publisher: RelayerPublisher;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    publisher = new RelayerPublisher(bus, "test-relayer");
  });

  afterEach(async () => {
    await bus.close();
  });

  it("publishes contract.event_logged with normalised payload", async () => {
    const received: EventMessage[] = [];
    bus.subscribe(EVENT_TYPES.CONTRACT_EVENT_LOGGED, async (m) => { received.push(m); });

    const raw = makeRawEvent({ event_type: "transfer", index: 42 });
    await publisher.publishContractEvent(raw, "corr-001");

    expect(received).toHaveLength(1);
    const payload = received[0].payload as ContractEventPayload;
    expect(payload.index).toBe(42);
    expect(payload.eventType).toBe("transfer");
    expect(payload.submitter).toBe("GADDR123");
    expect(received[0].correlationId).toBe("corr-001");
    expect(received[0].source).toBe("test-relayer");
  });

  it("publishes contract.event_relayed with EVM tx hash", async () => {
    const received: EventMessage[] = [];
    bus.subscribe(EVENT_TYPES.CONTRACT_EVENT_RELAYED, async (m) => { received.push(m); });

    await publisher.publishRelayedEvent(
      makeRawEvent(),
      "0xevmtx123",
      "1",
    );

    expect(received).toHaveLength(1);
    const payload = received[0].payload as RelayedEventPayload;
    expect(payload.evmTxHash).toBe("0xevmtx123");
    expect(payload.evmChainId).toBe("1");
  });

  it("publishes contract.event_skipped with reason", async () => {
    const received: EventMessage[] = [];
    bus.subscribe(EVENT_TYPES.CONTRACT_EVENT_SKIPPED, async (m) => { received.push(m); });

    await publisher.publishSkippedEvent(makeRawEvent(), "event_type not in allowlist");

    expect(received).toHaveLength(1);
    const payload = received[0].payload as SkippedEventPayload;
    expect(payload.reason).toBe("event_type not in allowlist");
  });

  it("publishes contract.relay_error with error message", async () => {
    const received: EventMessage[] = [];
    bus.subscribe(EVENT_TYPES.CONTRACT_RELAY_ERROR, async (m) => { received.push(m); });

    await publisher.publishRelayError(new Error("RPC timeout"), makeRawEvent());

    expect(received).toHaveLength(1);
    const payload = received[0].payload as RelayErrorPayload;
    expect(payload.error).toBe("RPC timeout");
    expect(payload.eventIndex).toBe(1);
  });

  it("publishes relay error with string message", async () => {
    const received: EventMessage[] = [];
    bus.subscribe(EVENT_TYPES.CONTRACT_RELAY_ERROR, async (m) => { received.push(m); });

    await publisher.publishRelayError("network unreachable");

    const payload = received[0].payload as RelayErrorPayload;
    expect(payload.error).toBe("network unreachable");
    expect(payload.rawEvent).toBeUndefined();
  });
});

// ── NotifierSubscriber ────────────────────────────────────────────────────────

describe("NotifierSubscriber", () => {
  let bus: InMemoryEventBus;
  let publisher: RelayerPublisher;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    publisher = new RelayerPublisher(bus);
  });

  afterEach(async () => {
    await bus.close();
  });

  it("forwards contract.event_logged to notifier.processEvent", async () => {
    const processed: object[] = [];
    const notifier: NotifierLike = {
      async processEvent(evt) { processed.push(evt); },
    };

    const sub = new NotifierSubscriber(bus, notifier);
    sub.start();

    await publisher.publishContractEvent(makeRawEvent({ event_type: "payment", index: 10 }));

    expect(processed).toHaveLength(1);
    expect((processed[0] as { event_type: string }).event_type).toBe("payment");
    expect((processed[0] as { index: number }).index).toBe(10);

    sub.stop();
  });

  it("forwards contract.event_relayed to notifier.processEvent", async () => {
    const processed: object[] = [];
    const notifier: NotifierLike = {
      async processEvent(evt) { processed.push(evt); },
    };

    const sub = new NotifierSubscriber(bus, notifier);
    sub.start();

    await publisher.publishRelayedEvent(makeRawEvent(), "0xtx", "1");

    expect(processed).toHaveLength(1);

    sub.stop();
  });

  it("does not forward contract.event_skipped to notifier", async () => {
    const processed: object[] = [];
    const notifier: NotifierLike = {
      async processEvent(evt) { processed.push(evt); },
    };

    const sub = new NotifierSubscriber(bus, notifier);
    sub.start();

    await publisher.publishSkippedEvent(makeRawEvent(), "filtered");

    expect(processed).toHaveLength(0);

    sub.stop();
  });

  it("stop() cancels the subscription", async () => {
    const processed: object[] = [];
    const notifier: NotifierLike = {
      async processEvent(evt) { processed.push(evt); },
    };

    const sub = new NotifierSubscriber(bus, notifier);
    sub.start();
    sub.stop();

    await publisher.publishContractEvent(makeRawEvent());

    expect(processed).toHaveLength(0);
  });

  it("warns on duplicate start() but does not create extra subscriptions", () => {
    const notifier: NotifierLike = { async processEvent() {} };
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const sub = new NotifierSubscriber(bus, notifier);
    sub.start();
    sub.start(); // duplicate

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("already started"),
    );

    // Only one subscription
    expect(bus.getMetrics().activeSubscriptions).toBe(1);

    sub.stop();
    warnSpy.mockRestore();
  });
});

// ── AnalyticsSubscriber ───────────────────────────────────────────────────────

describe("AnalyticsSubscriber", () => {
  let bus: InMemoryEventBus;
  let publisher: RelayerPublisher;
  let sink: InMemoryAnalyticsSink;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    publisher = new RelayerPublisher(bus);
    sink = new InMemoryAnalyticsSink();
  });

  afterEach(async () => {
    await bus.close();
  });

  it("records all four event types", async () => {
    const sub = new AnalyticsSubscriber(bus, sink);
    sub.start();

    await publisher.publishContractEvent(makeRawEvent());
    await publisher.publishRelayedEvent(makeRawEvent(), "0xtx");
    await publisher.publishSkippedEvent(makeRawEvent(), "excluded");
    await publisher.publishRelayError("boom");

    expect(sink.records).toHaveLength(4);

    const types = sink.records.map((r: AnalyticsRecord) => r.messageType);
    expect(types).toContain(EVENT_TYPES.CONTRACT_EVENT_LOGGED);
    expect(types).toContain(EVENT_TYPES.CONTRACT_EVENT_RELAYED);
    expect(types).toContain(EVENT_TYPES.CONTRACT_EVENT_SKIPPED);
    expect(types).toContain(EVENT_TYPES.CONTRACT_RELAY_ERROR);

    sub.stop();
  });

  it("sets recordedAt as ISO string", async () => {
    const sub = new AnalyticsSubscriber(bus, sink);
    sub.start();

    await publisher.publishContractEvent(makeRawEvent());

    expect(sink.records[0].recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    sub.stop();
  });
});

// ── BridgeSubscriber ──────────────────────────────────────────────────────────

describe("BridgeSubscriber", () => {
  let bus: InMemoryEventBus;
  let publisher: RelayerPublisher;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    publisher = new RelayerPublisher(bus);
  });

  afterEach(async () => {
    await bus.close();
  });

  it("routes each event type to the correct handler method", async () => {
    const calls: string[] = [];

    const handler: BridgeHandler = {
      async handleEvent() { calls.push("event"); },
      async handleRelayedEvent() { calls.push("relayed"); },
      async handleSkippedEvent() { calls.push("skipped"); },
      async handleRelayError() { calls.push("error"); },
    };

    const sub = new BridgeSubscriber(bus, handler);
    sub.start();

    await publisher.publishContractEvent(makeRawEvent());
    await publisher.publishRelayedEvent(makeRawEvent(), "0xtx");
    await publisher.publishSkippedEvent(makeRawEvent(), "reason");
    await publisher.publishRelayError("err");

    expect(calls).toEqual(["event", "relayed", "skipped", "error"]);

    sub.stop();
  });
});

// ── EventBusMetricsReporter ───────────────────────────────────────────────────

describe("EventBusMetricsReporter", () => {
  let bus: InMemoryEventBus;

  beforeEach(() => {
    bus = new InMemoryEventBus();
  });

  afterEach(async () => {
    await bus.close();
  });

  it("renderMetrics() returns Prometheus text format", async () => {
    bus.subscribe("payment", async () => {});
    await bus.publish({ type: "payment", source: "test", version: 1, payload: {} });

    const reporter = new EventBusMetricsReporter(bus);
    const output = reporter.renderMetrics();

    expect(output).toContain("# HELP event_bus_published_total");
    expect(output).toContain("# TYPE event_bus_published_total counter");
    expect(output).toContain("# HELP event_bus_dlq_size");
    expect(output).toContain("# TYPE event_bus_dlq_size gauge");
    expect(output).toContain("# HELP event_bus_active_subscriptions");
    expect(output).toContain("# HELP event_bus_publish_duration_ms");
    expect(output).toContain("# TYPE event_bus_publish_duration_ms histogram");
  });

  it("reflects metrics after publish", async () => {
    const reporter = new EventBusMetricsReporter(bus);

    await bus.publish({ type: "payment", source: "test", version: 1, payload: {} });

    const output = reporter.renderMetrics();
    expect(output).toMatch(/event_bus_published_total \d+/);
  });
});

// ── Concurrent reliability ────────────────────────────────────────────────────

describe("Concurrent reliability", () => {
  let bus: InMemoryEventBus;

  beforeEach(() => {
    bus = new InMemoryEventBus();
  });

  afterEach(async () => {
    await bus.close();
  });

  it("handles 100 concurrent publishes without dropping events", async () => {
    const received: EventMessage[] = [];
    bus.subscribe("load", async (m) => { received.push(m); });

    const publishes = Array.from({ length: 100 }, (_, i) =>
      bus.publish({ type: "load", source: "test", version: 1, payload: { i } }),
    );

    await Promise.all(publishes);

    expect(received).toHaveLength(100);
    expect(bus.getMetrics().published).toBe(100);
    expect(bus.getMetrics().delivered).toBe(100);
  });

  it("routes events to multiple independent subscribers", async () => {
    const s1: EventMessage[] = [];
    const s2: EventMessage[] = [];
    const s3: EventMessage[] = [];

    bus.subscribe("x", async (m) => { s1.push(m); });
    bus.subscribe("x", async (m) => { s2.push(m); });
    bus.subscribe("x", async (m) => { s3.push(m); });

    await bus.publish({ type: "x", source: "t", version: 1, payload: {} });

    expect(s1).toHaveLength(1);
    expect(s2).toHaveLength(1);
    expect(s3).toHaveLength(1);
  });
});

// ── Replay edge cases ─────────────────────────────────────────────────────────

describe("Replay edge cases", () => {
  let bus: InMemoryEventBus;

  beforeEach(() => {
    bus = new InMemoryEventBus();
  });

  afterEach(async () => {
    await bus.close();
  });

  it("returns empty array when no events published", async () => {
    const result = await bus.replay({});
    expect(result).toHaveLength(0);
  });

  it("returns all events when no filters applied", async () => {
    for (let i = 0; i < 10; i++) {
      await bus.publish({ type: "evt", source: "t", version: 1, payload: { i } });
    }
    const result = await bus.replay({});
    expect(result).toHaveLength(10);
  });

  it("limit=0 is treated as no-limit", async () => {
    for (let i = 0; i < 5; i++) {
      await bus.publish({ type: "evt", source: "t", version: 1, payload: { i } });
    }
    const result = await bus.replay({ limit: 0 });
    expect(result).toHaveLength(5);
  });

  it("fromOffset beyond log length returns empty array", async () => {
    await bus.publish({ type: "evt", source: "t", version: 1, payload: {} });
    const result = await bus.replay({ fromOffset: 100 });
    expect(result).toHaveLength(0);
  });

  it("preserves event ordering", async () => {
    const indices = [1, 2, 3, 4, 5];
    for (const i of indices) {
      await bus.publish({ type: "ordered", source: "t", version: 1, payload: { i } });
    }

    const result = await bus.replay({ types: ["ordered"] });
    const payloadIndices = result.map((m) => (m.payload as { i: number }).i);
    expect(payloadIndices).toEqual(indices);
  });
});

// ── EventBusFactory ───────────────────────────────────────────────────────────

describe("EventBusFactory", () => {
  it("creates an InMemoryEventBus by default", () => {
    const bus = createEventBus();
    expect(typeof bus.publish).toBe("function");
    expect(typeof bus.subscribe).toBe("function");
    void bus.close();
  });

  it("creates an InMemoryEventBus when backend=memory", () => {
    const bus = createEventBus({ backend: "memory" });
    expect(typeof bus.publish).toBe("function");
    void bus.close();
  });

  it("throws for redis backend when ioredis is not installed", () => {
    expect(() => createEventBus({ backend: "redis", redis: { host: "localhost", port: 6379 } }))
      .toThrow(/ioredis/i);
  });

  it("throws for nats backend when nats is not installed", () => {
    expect(() => createEventBus({ backend: "nats", nats: { servers: ["nats://localhost:4222"] } }))
      .toThrow(/nats/i);
  });

  it("respects EVENT_BUS_BACKEND env var", () => {
    const original = process.env["EVENT_BUS_BACKEND"];
    process.env["EVENT_BUS_BACKEND"] = "memory";

    const bus = createEventBus();
    expect(typeof bus.publish).toBe("function");
    void bus.close();

    if (original === undefined) {
      delete process.env["EVENT_BUS_BACKEND"];
    } else {
      process.env["EVENT_BUS_BACKEND"] = original;
    }
  });
});

// ── DLQ reliability ───────────────────────────────────────────────────────────

describe("DLQ reliability", () => {
  let bus: InMemoryEventBus;

  beforeEach(() => {
    bus = new InMemoryEventBus();
  });

  afterEach(async () => {
    await bus.close();
  });

  it("DLQ entry contains the original message and subscriber ID", async () => {
    const sub = bus.subscribe(
      "fail",
      async () => { throw new Error("intentional"); },
      { maxRetries: 0, retryDelay: 1, dlq: true },
    );

    await bus.publish({ type: "fail", source: "t", version: 1, payload: { x: 1 } });

    const dlq = bus.getDLQ();
    expect(dlq).toHaveLength(1);
    expect(dlq[0].subscriberId).toBe(sub.id);
    expect(dlq[0].error).toBe("intentional");
    expect(dlq[0].attempts).toBe(1);
    expect((dlq[0].message.payload as { x: number }).x).toBe(1);
  });

  it("requeueDLQ returns 0 when DLQ is empty", async () => {
    const count = await bus.requeueDLQ();
    expect(count).toBe(0);
  });

  it("multiple DLQ entries can be selectively requeued", async () => {
    const delivered: number[] = [];
    let failAll = true;

    bus.subscribe(
      "dlqtest",
      async (msg) => {
        const payload = msg.payload as { n: number };
        if (failAll && payload.n < 3) throw new Error("fail");
        delivered.push(payload.n);
      },
      { maxRetries: 0, retryDelay: 1, dlq: true },
    );

    await bus.publish({ type: "dlqtest", source: "t", version: 1, payload: { n: 1 } });
    await bus.publish({ type: "dlqtest", source: "t", version: 1, payload: { n: 2 } });
    await bus.publish({ type: "dlqtest", source: "t", version: 1, payload: { n: 3 } });

    expect(bus.getDLQ()).toHaveLength(2);
    expect(delivered).toEqual([3]);

    failAll = false;
    const requeued = await bus.requeueDLQ();
    expect(requeued).toBe(2);
    expect(delivered).toEqual([3, 1, 2]);
  });
});

// ── EventFilter edge cases ────────────────────────────────────────────────────

describe("EventFilter edge cases", () => {
  let bus: InMemoryEventBus;

  beforeEach(() => {
    bus = new InMemoryEventBus();
  });

  afterEach(async () => {
    await bus.close();
  });

  it("empty types array on filter does NOT block all messages", async () => {
    const received: EventMessage[] = [];
    bus.subscribe(
      "payment",
      async (m) => { received.push(m); },
      { filter: { types: [] } }, // empty = no restriction
    );

    await bus.publish({ type: "payment", source: "t", version: 1, payload: {} });

    expect(received).toHaveLength(1);
  });

  it("predicate returning false blocks delivery", async () => {
    const received: EventMessage[] = [];
    bus.subscribe(
      "payment",
      async (m) => { received.push(m); },
      {
        filter: {
          predicate: (msg) => (msg.payload as { amount: number }).amount >= 1000,
        },
      },
    );

    await bus.publish({ type: "payment", source: "t", version: 1, payload: { amount: 500 } });
    await bus.publish({ type: "payment", source: "t", version: 1, payload: { amount: 2000 } });

    expect(received).toHaveLength(1);
    expect((received[0].payload as { amount: number }).amount).toBe(2000);
  });

  it("version field is preserved through publish", async () => {
    const received: EventMessage[] = [];
    bus.subscribe("v2event", async (m) => { received.push(m); });

    await bus.publish({ type: "v2event", source: "t", version: 2, payload: {} });

    expect(received[0].version).toBe(2);
  });

  it("metadata field is preserved through publish", async () => {
    const received: EventMessage[] = [];
    bus.subscribe("traced", async (m) => { received.push(m); });

    await bus.publish({
      type: "traced",
      source: "t",
      version: 1,
      payload: {},
      metadata: { traceId: "abc123" },
    });

    expect((received[0].metadata as { traceId: string }).traceId).toBe("abc123");
  });
});

// ── Bridge Relayer & Subscriber End-to-End ───────────────────────────────────

describe("Bridge Relayer to BridgeSubscriber Integration", () => {
  let bus: InMemoryEventBus;

  beforeEach(() => {
    bus = new InMemoryEventBus();
  });

  afterEach(async () => {
    await bus.close();
  });

  it("publishes contract events through RelayerPublisher to BridgeSubscriber", async () => {
    const eventsHandled: any[] = [];
    const relayedHandled: any[] = [];
    const skippedHandled: any[] = [];
    const errorsHandled: any[] = [];

    const bridgeHandler = {
      handleEvent: async (payload: any) => {
        eventsHandled.push(payload);
      },
      handleRelayedEvent: async (payload: any) => {
        relayedHandled.push(payload);
      },
      handleSkippedEvent: async (payload: any) => {
        skippedHandled.push(payload);
      },
      handleRelayError: async (payload: any) => {
        errorsHandled.push(payload);
      },
    };

    const subscriber = new BridgeSubscriber(bus, bridgeHandler);
    subscriber.start();

    const publisher = new RelayerPublisher(bus, "stellar-relayer");

    const rawEvent = {
      index: 10,
      timestamp: 1700000000,
      event_type: "asset.transfer",
      submitter: "GABC123",
      metadata: "hexdata",
      event_hash: "0xhash123",
      ledger_seq: 50000,
      tx_hash: "0xtx123",
    };

    // 1. Publish contract logged event
    await publisher.publishContractEvent(rawEvent, "corr-1");
    expect(eventsHandled).toHaveLength(1);
    expect(eventsHandled[0].index).toBe(10);
    expect(eventsHandled[0].eventType).toBe("asset.transfer");

    // 2. Publish relayed event
    await publisher.publishRelayedEvent(rawEvent, "0xevmTx456", "1", "corr-2");
    expect(relayedHandled).toHaveLength(1);
    expect(relayedHandled[0].evmTxHash).toBe("0xevmTx456");

    // 3. Publish skipped event
    await publisher.publishSkippedEvent(rawEvent, "filtered_by_type", "corr-3");
    expect(skippedHandled).toHaveLength(1);
    expect(skippedHandled[0].reason).toBe("filtered_by_type");

    // 4. Publish relay error
    await publisher.publishRelayError("RPC timeout", rawEvent);
    expect(errorsHandled).toHaveLength(1);
    expect(errorsHandled[0].error).toBe("RPC timeout");

    subscriber.stop();
  });
});
