/**
 * EventBusBase — Abstract base class for all event bus implementations.
 *
 * Provides:
 *  - Subscription registry (Map<id, SubscriptionRecord>)
 *  - Dead-letter queue
 *  - Metrics counters
 *  - applyFilter()      — declarative message filtering
 *  - routeToSubscribers() — fan-out with exponential back-off retry + DLQ
 *  - getMetrics() / getDLQ() / requeueDLQ()
 *  - generateId()       — UUID v4 via Node's built-in crypto
 *
 * Concrete subclasses must implement: publish(), replay(), close().
 */

import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import type {
  EventMessage,
  EventFilter,
  SubscriptionOptions,
  Subscription,
  DeadLetterEntry,
  EventBusMetrics,
  EventReplayOptions,
  IEventBus,
} from "./types";

// ── Internal record kept per active subscription ──────────────────────────────

interface SubscriptionRecord {
  id: string;
  /** Normalised type allowlist derived from the `subscribe()` call. */
  types: string[];
  handler: (msg: EventMessage) => Promise<void>;
  options: Required<Pick<SubscriptionOptions, "maxRetries" | "retryDelay" | "dlq">> &
    Pick<SubscriptionOptions, "filter" | "groupId">;
}

// ── EventBusBase ──────────────────────────────────────────────────────────────

export abstract class EventBusBase extends EventEmitter implements IEventBus {
  /** All currently active subscriptions, keyed by subscription ID. */
  protected subscriptions: Map<string, SubscriptionRecord> = new Map();

  /** Dead-letter queue — messages that exhausted all retry attempts. */
  protected dlq: DeadLetterEntry[] = [];

  /** Mutable metrics counters. */
  protected metrics = {
    published: 0,
    delivered: 0,
    failed: 0,
  };

  // ── ID generation ───────────────────────────────────────────────────────────

  /** Returns a cryptographically random UUID v4. */
  protected generateId(): string {
    return randomUUID();
  }

  // ── Filter logic ────────────────────────────────────────────────────────────

  /**
   * Returns `true` when `message` passes all conditions in `filter`.
   *
   * Evaluation order:
   *  1. `filter.types`   — message.type must be in the allowlist (if set).
   *  2. `filter.sources` — message.source must be in the allowlist (if set).
   *  3. `filter.predicate` — must return true (if set).
   */
  protected applyFilter(message: EventMessage, filter: EventFilter): boolean {
    if (filter.types && filter.types.length > 0) {
      if (!filter.types.includes(message.type)) return false;
    }
    if (filter.sources && filter.sources.length > 0) {
      if (!filter.sources.includes(message.source)) return false;
    }
    if (filter.predicate) {
      if (!filter.predicate(message)) return false;
    }
    return true;
  }

  // ── Fan-out with retry ──────────────────────────────────────────────────────

  /**
   * Delivers `message` to every matching subscriber.
   *
   * For each subscriber:
   *  - Checks the subscription-level type allowlist (fast path).
   *  - Applies the `EventFilter` if one is configured.
   *  - Calls the handler up to `maxRetries` times with exponential back-off.
   *  - On exhaustion, pushes to DLQ (when `dlq: true`) and increments
   *    `metrics.failed`.
   */
  protected async routeToSubscribers(message: EventMessage): Promise<void> {
    const deliveryPromises: Promise<void>[] = [];

    for (const record of this.subscriptions.values()) {
      // Fast-path type check (subscription-level type list)
      if (record.types.length > 0 && !record.types.includes(message.type)) {
        continue;
      }

      // Declarative filter (if configured)
      if (record.options.filter) {
        if (!this.applyFilter(message, record.options.filter)) {
          continue;
        }
      }

      deliveryPromises.push(this.deliverWithRetry(message, record));
    }

    await Promise.all(deliveryPromises);
  }

  /** Attempts delivery to a single subscriber, retrying with back-off. */
  private async deliverWithRetry(
    message: EventMessage,
    record: SubscriptionRecord,
  ): Promise<void> {
    const { maxRetries, retryDelay, dlq: enableDlq } = record.options;
    let lastError: Error = new Error("unknown");

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await record.handler(message);
        this.metrics.delivered++;
        return; // success — stop retrying
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < maxRetries) {
          // Exponential back-off: delay * 2^attempt
          const backoff = retryDelay * Math.pow(2, attempt);
          await sleep(backoff);
        }
      }
    }

    // All attempts exhausted
    this.metrics.failed++;

    if (enableDlq) {
      this.dlq.push({
        message,
        error: lastError.message,
        attempts: maxRetries + 1,
        failedAt: Date.now(),
        subscriberId: record.id,
      });
    }

    this.emit("delivery_failed", { subscriberId: record.id, message, error: lastError });
  }

  // ── Subscription management ─────────────────────────────────────────────────

  subscribe(
    types: string | string[],
    handler: (msg: EventMessage) => Promise<void>,
    options: SubscriptionOptions = {},
  ): Subscription {
    const id = this.generateId();
    const normalizedTypes = Array.isArray(types) ? types : [types];

    const record: SubscriptionRecord = {
      id,
      types: normalizedTypes,
      handler,
      options: {
        maxRetries: options.maxRetries ?? 3,
        retryDelay: options.retryDelay ?? 1000,
        dlq: options.dlq ?? true,
        filter: options.filter,
        groupId: options.groupId,
      },
    };

    this.subscriptions.set(id, record);
    this.emit("subscribed", { id, types: normalizedTypes });

    return {
      id,
      unsubscribe: () => this.unsubscribe(id),
    };
  }

  unsubscribe(id: string): void {
    if (this.subscriptions.delete(id)) {
      this.emit("unsubscribed", { id });
    }
  }

  // ── Metrics ────────────────────────────────────────────────────────────────

  getMetrics(): EventBusMetrics {
    return {
      published: this.metrics.published,
      delivered: this.metrics.delivered,
      failed: this.metrics.failed,
      dlqSize: this.dlq.length,
      activeSubscriptions: this.subscriptions.size,
    };
  }

  // ── Dead-letter queue ───────────────────────────────────────────────────────

  getDLQ(): DeadLetterEntry[] {
    return [...this.dlq];
  }

  /**
   * Re-delivers DLQ entries.
   *
   * @param entryId  When given, only the entry whose `message.id` matches is
   *                 requeued.  When omitted, every entry is requeued.
   * @returns        Number of entries submitted for redelivery.
   */
  async requeueDLQ(entryId?: string): Promise<number> {
    let entries: DeadLetterEntry[];

    if (entryId !== undefined) {
      entries = this.dlq.filter((e) => e.message.id === entryId);
    } else {
      entries = [...this.dlq];
    }

    if (entries.length === 0) return 0;

    // Remove requeued entries from the DLQ before retrying so that failures
    // during requeue don't result in duplicates.
    if (entryId !== undefined) {
      this.dlq = this.dlq.filter((e) => e.message.id !== entryId);
    } else {
      this.dlq = [];
    }

    await Promise.all(entries.map((e) => this.routeToSubscribers(e.message)));

    return entries.length;
  }

  // ── Abstract interface ──────────────────────────────────────────────────────

  abstract publish(message: Omit<EventMessage, "id" | "timestamp">): Promise<void>;
  abstract replay(options: EventReplayOptions): Promise<EventMessage[]>;
  abstract close(): Promise<void>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
