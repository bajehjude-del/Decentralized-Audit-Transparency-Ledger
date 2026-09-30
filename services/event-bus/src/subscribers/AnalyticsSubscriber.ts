/**
 * AnalyticsSubscriber
 *
 * Subscribes to the event bus and drives downstream analytics pipelines
 * (ClickHouse, BigQuery, data lake, etc.).
 *
 * It handles all event types emitted by the relayer:
 *   - contract.event_logged   → record raw event in analytics store
 *   - contract.event_relayed  → record cross-chain relay metrics
 *   - contract.event_skipped  → record filter rejection metrics
 *   - contract.relay_error    → record error analytics
 *
 * Architecture:
 *   EventBus ──► AnalyticsSubscriber ──► AnalyticsSink.record()
 *
 * Usage:
 *   const subscriber = new AnalyticsSubscriber(bus, sink);
 *   subscriber.start();
 *   // …
 *   subscriber.stop();
 */

import type { IEventBus, EventMessage, Subscription } from "../types";
import {
  EVENT_TYPES,
  type ContractEventPayload,
  type RelayedEventPayload,
  type SkippedEventPayload,
  type RelayErrorPayload,
} from "../publishers/RelayerPublisher";

// ── Analytics sink interface ──────────────────────────────────────────────────

/**
 * Structural interface for any analytics backend.
 * Implement this to write events to ClickHouse, BigQuery, a data lake, etc.
 */
export interface AnalyticsSink {
  recordEvent(event: AnalyticsRecord): Promise<void>;
}

/** Normalised analytics record written to the sink for every event. */
export interface AnalyticsRecord {
  /** ISO-8601 wall-clock time the record was created. */
  recordedAt: string;
  /** Event bus message ID (UUID). */
  messageId: string;
  /** Type discriminator (e.g. "contract.event_logged"). */
  messageType: string;
  /** Source service that emitted the event. */
  source: string;
  /** Domain payload (varies by messageType). */
  payload: unknown;
  /** Optional correlation ID for distributed tracing. */
  correlationId?: string;
}

// ── In-memory sink (useful in tests / local dev) ─────────────────────────────

export class InMemoryAnalyticsSink implements AnalyticsSink {
  public readonly records: AnalyticsRecord[] = [];

  async recordEvent(record: AnalyticsRecord): Promise<void> {
    this.records.push(record);
  }
}

// ── AnalyticsSubscriber ───────────────────────────────────────────────────────

export class AnalyticsSubscriber {
  private subscriptions: Subscription[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly sink: AnalyticsSink,
  ) {}

  /**
   * Starts listening for all relayer event types on the bus and
   * forwards each to the analytics sink.
   */
  start(): void {
    if (this.subscriptions.length > 0) {
      console.warn("[AnalyticsSubscriber] already started — ignoring duplicate start()");
      return;
    }

    // Subscribe to every relayer event type in a single subscription
    const allTypes = Object.values(EVENT_TYPES);

    const sub = this.bus.subscribe(
      allTypes,
      async (msg: EventMessage) => {
        const record: AnalyticsRecord = {
          recordedAt: new Date().toISOString(),
          messageId: msg.id,
          messageType: msg.type,
          source: msg.source,
          payload: msg.payload,
          correlationId: msg.correlationId,
        };
        await this.sink.recordEvent(record);
      },
      {
        groupId: "analytics-service",
        maxRetries: 5,
        retryDelay: 200,
        dlq: true,
      },
    );

    this.subscriptions.push(sub);
    console.log(`[AnalyticsSubscriber] subscribed to ${allTypes.length} types (id=${sub.id})`);
  }

  /**
   * Cancels all event bus subscriptions.
   */
  stop(): void {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];
    console.log("[AnalyticsSubscriber] stopped");
  }

  get subscriptionIds(): string[] {
    return this.subscriptions.map((s) => s.id);
  }
}

// ── BridgeSubscriber ──────────────────────────────────────────────────────────

export {
  BridgeSubscriber,
  createBridgeSubscriber,
} from "./BridgeSubscriber";
export type { BridgeHandler } from "./BridgeSubscriber";

// ── Factories ─────────────────────────────────────────────────────────────────

export function createAnalyticsSubscriber(
  bus: IEventBus,
  sink: AnalyticsSink,
): AnalyticsSubscriber {
  return new AnalyticsSubscriber(bus, sink);
}
