/**
 * InMemoryEventBus — unit tests
 */
import { InMemoryEventBus, createInMemoryEventBus } from "../InMemoryEventBus";
import type { EventMessage } from "../types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMsg(overrides: Partial<Omit<EventMessage, "id" | "timestamp">> = {}) {
  return {
    type: "payment",
    source: "contract",
    version: 1 as const,
    payload: { amount: 100 },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("InMemoryEventBus", () => {
  let bus: InMemoryEventBus;

  beforeEach(() => {
    bus = new InMemoryEventBus();
  });

  afterEach(async () => {
    await bus.close();
  });

  // ── publish ────────────────────────────────────────────────────────────────

  it("stamps id and timestamp on publish", async () => {
    const received: EventMessage[] = [];
    bus.subscribe("payment", async (msg) => { received.push(msg); });

    const before = Date.now();
    await bus.publish(makeMsg());
    const after = Date.now();

    expect(received).toHaveLength(1);
    expect(received[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(received[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(received[0].timestamp).toBeLessThanOrEqual(after);
  });

  it("increments metrics.published", async () => {
    await bus.publish(makeMsg());
    await bus.publish(makeMsg());
    expect(bus.getMetrics().published).toBe(2);
  });

  // ── subscribe ──────────────────────────────────────────────────────────────

  it("delivers only matching types", async () => {
    const payments: EventMessage[] = [];
    const transfers: EventMessage[] = [];

    bus.subscribe("payment", async (m) => { payments.push(m); });
    bus.subscribe("transfer", async (m) => { transfers.push(m); });

    await bus.publish(makeMsg({ type: "payment" }));
    await bus.publish(makeMsg({ type: "transfer" }));

    expect(payments).toHaveLength(1);
    expect(transfers).toHaveLength(1);
  });

  it("returns a working unsubscribe handle", async () => {
    const received: EventMessage[] = [];
    const sub = bus.subscribe("payment", async (m) => { received.push(m); });

    await bus.publish(makeMsg());
    sub.unsubscribe();
    await bus.publish(makeMsg());

    expect(received).toHaveLength(1);
  });

  it("delivers to multiple type subscriptions", async () => {
    const received: EventMessage[] = [];
    bus.subscribe(["payment", "transfer"], async (m) => { received.push(m); });

    await bus.publish(makeMsg({ type: "payment" }));
    await bus.publish(makeMsg({ type: "transfer" }));
    await bus.publish(makeMsg({ type: "refund" }));

    expect(received).toHaveLength(2);
  });

  // ── EventFilter ────────────────────────────────────────────────────────────

  it("honours filter.sources", async () => {
    const received: EventMessage[] = [];
    bus.subscribe("payment", async (m) => { received.push(m); }, {
      filter: { sources: ["contract-a"] },
    });

    await bus.publish(makeMsg({ source: "contract-a" }));
    await bus.publish(makeMsg({ source: "contract-b" }));

    expect(received).toHaveLength(1);
    expect(received[0].source).toBe("contract-a");
  });

  it("honours filter.predicate", async () => {
    const received: EventMessage[] = [];
    bus.subscribe("payment", async (m) => { received.push(m); }, {
      filter: { predicate: (msg) => (msg.payload as { amount: number }).amount > 50 },
    });

    await bus.publish(makeMsg({ payload: { amount: 100 } }));
    await bus.publish(makeMsg({ payload: { amount: 10 } }));

    expect(received).toHaveLength(1);
  });

  // ── Retry / DLQ ───────────────────────────────────────────────────────────

  it("retries a failing handler and routes to DLQ after exhaustion", async () => {
    let calls = 0;
    bus.subscribe("payment", async () => {
      calls++;
      throw new Error("handler error");
    }, { maxRetries: 2, retryDelay: 1, dlq: true });

    await bus.publish(makeMsg());

    // 1 initial + 2 retries = 3 total calls
    expect(calls).toBe(3);
    expect(bus.getDLQ()).toHaveLength(1);
    expect(bus.getMetrics().failed).toBe(1);
  });

  it("does not add to DLQ when dlq:false", async () => {
    bus.subscribe("payment", async () => { throw new Error("nope"); }, {
      maxRetries: 0,
      retryDelay: 1,
      dlq: false,
    });

    await bus.publish(makeMsg());

    expect(bus.getDLQ()).toHaveLength(0);
    expect(bus.getMetrics().failed).toBe(1);
  });

  it("requeueDLQ redelivers all entries and clears them", async () => {
    let calls = 0;
    const shouldFail = { value: true };

    bus.subscribe("payment", async () => {
      calls++;
      if (shouldFail.value) throw new Error("fail");
    }, { maxRetries: 0, retryDelay: 1, dlq: true });

    await bus.publish(makeMsg());
    expect(bus.getDLQ()).toHaveLength(1);

    // Now let handler succeed
    shouldFail.value = false;
    const requeued = await bus.requeueDLQ();
    expect(requeued).toBe(1);
    expect(bus.getDLQ()).toHaveLength(0);
  });

  it("requeueDLQ with entryId only requeues the matching entry", async () => {
    bus.subscribe("payment", async () => { throw new Error("fail"); }, {
      maxRetries: 0, retryDelay: 1, dlq: true,
    });

    await bus.publish(makeMsg());
    await bus.publish(makeMsg());

    const dlq = bus.getDLQ();
    expect(dlq).toHaveLength(2);

    const targetId = dlq[0].message.id;
    const requeued = await bus.requeueDLQ(targetId);
    expect(requeued).toBe(1);
    // The re-queued entry ends up back in DLQ (handler still fails), the other remains
    expect(bus.getDLQ()).toHaveLength(2);
  });

  // ── replay ─────────────────────────────────────────────────────────────────

  it("replay returns all published events", async () => {
    await bus.publish(makeMsg({ type: "payment" }));
    await bus.publish(makeMsg({ type: "transfer" }));

    const result = await bus.replay({});
    expect(result).toHaveLength(2);
  });

  it("replay filters by types", async () => {
    await bus.publish(makeMsg({ type: "payment" }));
    await bus.publish(makeMsg({ type: "transfer" }));
    await bus.publish(makeMsg({ type: "payment" }));

    const result = await bus.replay({ types: ["payment"] });
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.type === "payment")).toBe(true);
  });

  it("replay respects fromTimestamp / toTimestamp", async () => {
    const t1 = Date.now();
    await bus.publish(makeMsg());
    const t2 = Date.now();
    await bus.publish(makeMsg());
    const t3 = Date.now();

    const allInRange = await bus.replay({ fromTimestamp: t1, toTimestamp: t3 });
    expect(allInRange).toHaveLength(2);

    const justFirst = await bus.replay({ toTimestamp: t2 });
    expect(justFirst.length).toBeGreaterThanOrEqual(1);
  });

  it("replay respects fromOffset and limit", async () => {
    for (let i = 0; i < 5; i++) {
      await bus.publish(makeMsg());
    }

    const sliced = await bus.replay({ fromOffset: 2, limit: 2 });
    expect(sliced).toHaveLength(2);
  });

  // ── metrics ────────────────────────────────────────────────────────────────

  it("metrics reflect active subscriptions", () => {
    const sub1 = bus.subscribe("payment", async () => { /* noop */ });
    const sub2 = bus.subscribe("transfer", async () => { /* noop */ });

    expect(bus.getMetrics().activeSubscriptions).toBe(2);

    sub1.unsubscribe();
    expect(bus.getMetrics().activeSubscriptions).toBe(1);

    sub2.unsubscribe();
    expect(bus.getMetrics().activeSubscriptions).toBe(0);
  });

  it("metrics.delivered increments on success", async () => {
    bus.subscribe("payment", async () => { /* noop */ });
    await bus.publish(makeMsg());
    expect(bus.getMetrics().delivered).toBe(1);
  });

  // ── factory ────────────────────────────────────────────────────────────────

  it("createInMemoryEventBus returns an IEventBus", () => {
    const b = createInMemoryEventBus();
    expect(typeof b.publish).toBe("function");
    expect(typeof b.subscribe).toBe("function");
    expect(typeof b.replay).toBe("function");
    expect(typeof b.getMetrics).toBe("function");
    expect(typeof b.getDLQ).toBe("function");
    expect(typeof b.requeueDLQ).toBe("function");
    expect(typeof b.close).toBe("function");
  });

  // ── close ──────────────────────────────────────────────────────────────────

  it("close clears subscriptions", async () => {
    bus.subscribe("payment", async () => { /* noop */ });
    await bus.close();
    expect(bus.getMetrics().activeSubscriptions).toBe(0);
  });
});
