/**
 * Event Bus — Shared Types & Interfaces
 *
 * All shared types used across the in-memory, Redis, and NATS implementations.
 */

// ── Core message envelope ─────────────────────────────────────────────────────

/**
 * The standard envelope wrapping every event flowing through the bus.
 * @template T  Shape of the domain payload (defaults to unknown).
 */
export interface EventMessage<T = unknown> {
  /** UUID v4 assigned by the bus at publish time. */
  id: string;
  /** Event category / discriminator (e.g. "payment", "transfer"). */
  type: string;
  /** Logical origin of the event (service name, contract address, etc.). */
  source: string;
  /** Unix epoch milliseconds assigned at publish time. */
  timestamp: number;
  /** Optional correlation ID for request tracing. */
  correlationId?: string;
  /** Optional causation ID linking this event to the event that caused it. */
  causationId?: string;
  /** Schema version. Consumers can gate on this for backwards-compat. */
  version: number;
  /** Domain-specific payload. */
  payload: T;
  /** Arbitrary extension metadata (headers, tracing spans, etc.). */
  metadata?: Record<string, unknown>;
}

// ── Filtering ─────────────────────────────────────────────────────────────────

/**
 * Declarative filter applied before a handler receives an event.
 * All set fields are ANDed together.
 */
export interface EventFilter {
  /** Allowlist of event types. Omit to accept all types. */
  types?: string[];
  /** Allowlist of source identifiers. Omit to accept all sources. */
  sources?: string[];
  /** Arbitrary predicate for complex filtering logic. */
  predicate?: (msg: EventMessage) => boolean;
}

// ── Subscription ──────────────────────────────────────────────────────────────

/**
 * Options controlling how a subscription handles delivery and failures.
 */
export interface SubscriptionOptions {
  /** Pre-delivery filter applied to incoming messages. */
  filter?: EventFilter;
  /** Consumer-group identifier (used by Redis Streams / NATS durable consumers). */
  groupId?: string;
  /** How many delivery attempts to make before routing to DLQ. Default: 3. */
  maxRetries?: number;
  /** Base delay in milliseconds for exponential back-off between retries. Default: 1000. */
  retryDelay?: number;
  /** Whether failed messages land in the dead-letter queue. Default: true. */
  dlq?: boolean;
}

/**
 * Handle returned by `subscribe()`. Call `unsubscribe()` to cancel delivery.
 */
export interface Subscription {
  /** Unique subscription identifier. */
  id: string;
  /** Cancels this subscription. Idempotent. */
  unsubscribe(): void;
}

// ── Dead-letter queue ─────────────────────────────────────────────────────────

/**
 * A message that exhausted all retry attempts.
 */
export interface DeadLetterEntry {
  /** The message that could not be delivered. */
  message: EventMessage;
  /** Stringified error from the last failed attempt. */
  error: string;
  /** Total delivery attempts made. */
  attempts: number;
  /** Unix epoch milliseconds when the entry was written to the DLQ. */
  failedAt: number;
  /** ID of the subscription that failed. */
  subscriberId: string;
}

// ── Metrics ───────────────────────────────────────────────────────────────────

/**
 * Operational counters exposed by every bus implementation.
 */
export interface EventBusMetrics {
  /** Total messages successfully published to the bus. */
  published: number;
  /** Total successful handler invocations across all subscribers. */
  delivered: number;
  /** Total handler failures after exhausting retries. */
  failed: number;
  /** Current number of entries in the dead-letter queue. */
  dlqSize: number;
  /** Current number of active subscriptions. */
  activeSubscriptions: number;
}

// ── Replay ────────────────────────────────────────────────────────────────────

/**
 * Options for replaying historical events from the bus's event log.
 */
export interface EventReplayOptions {
  /** Only return events at or after this timestamp (epoch ms). */
  fromTimestamp?: number;
  /** Only return events at or before this timestamp (epoch ms). */
  toTimestamp?: number;
  /** Skip the first N matching events (0-based offset). */
  fromOffset?: number;
  /** Allowlist of event types to include in the replay. */
  types?: string[];
  /** Maximum number of events to return. */
  limit?: number;
}

// ── Backend discriminator ────────────────────────────────────────────────────

/** Identifies the transport layer in use. */
export type EventBusBackend = "memory" | "redis" | "nats" | "kafka";

// ── IEventBus contract ────────────────────────────────────────────────────────

/**
 * Common interface implemented by all event bus backends.
 *
 * The bus is responsible for:
 *  - Stamping every outgoing message with a UUID `id` and `timestamp`.
 *  - Routing messages to matching subscribers with retry + DLQ semantics.
 *  - Maintaining an ordered event log for replay.
 */
export interface IEventBus {
  /**
   * Publish an event.  `id` and `timestamp` are stamped by the bus.
   */
  publish(message: Omit<EventMessage, "id" | "timestamp">): Promise<void>;

  /**
   * Register a handler for one or more event types.
   *
   * @param types      Single type string or array of types to match.
   * @param handler    Async function called for each matching message.
   * @param options    Delivery and filter options.
   * @returns          A {@link Subscription} handle for later cancellation.
   */
  subscribe(
    types: string | string[],
    handler: (msg: EventMessage) => Promise<void>,
    options?: SubscriptionOptions,
  ): Subscription;

  /**
   * Cancel a subscription by its ID. Idempotent.
   */
  unsubscribe(id: string): void;

  /**
   * Replay historical events from the bus's internal log.
   */
  replay(options: EventReplayOptions): Promise<EventMessage[]>;

  /** Snapshot of current operational counters. */
  getMetrics(): EventBusMetrics;

  /** All entries currently in the dead-letter queue. */
  getDLQ(): DeadLetterEntry[];

  /**
   * Re-deliver dead-letter entries.
   *
   * @param entryId  When provided, only requeue the entry whose
   *                 `message.id` matches.  Otherwise requeues all entries.
   * @returns        Number of entries requeued.
   */
  requeueDLQ(entryId?: string): Promise<number>;

  /** Gracefully shut down the bus and release all resources. */
  close(): Promise<void>;
}
