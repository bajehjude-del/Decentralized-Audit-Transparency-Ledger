/**
 * InMemoryEventBus — local, zero-dependency event bus.
 *
 * All events are fanned out synchronously within the same process.
 * An internal event log (capped at MAX_LOG_SIZE entries) supports replay.
 *
 * This is the default backend used when no external broker is configured.
 */

import { EventBusBase } from "./EventBusBase";
import type {
  EventMessage,
  EventReplayOptions,
  IEventBus,
  Subscription,
  SubscriptionOptions,
} from "./types";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum number of events retained in the in-memory log. */
const MAX_LOG_SIZE = 10_000;

// ── InMemoryEventBus ──────────────────────────────────────────────────────────

export class InMemoryEventBus extends EventBusBase {
  /** Ordered log of every published event — supports replay. */
  private eventLog: EventMessage[] = [];

  // ── publish ─────────────────────────────────────────────────────────────────

  async publish(message: Omit<EventMessage, "id" | "timestamp">): Promise<void> {
    const stamped: EventMessage = {
      ...{ version: 1 },
      ...message,
      id: this.generateId(),
      timestamp: Date.now(),
    };

    // Cap the log to avoid unbounded memory growth
    this.eventLog.push(stamped);
    if (this.eventLog.length > MAX_LOG_SIZE) {
      this.eventLog.shift();
    }

    this.metrics.published++;

    await this.routeToSubscribers(stamped);
  }

  // ── subscribe ───────────────────────────────────────────────────────────────

  // Delegates entirely to EventBusBase — included here for clarity.
  subscribe(
    types: string | string[],
    handler: (msg: EventMessage) => Promise<void>,
    options?: SubscriptionOptions,
  ): Subscription {
    return super.subscribe(types, handler, options);
  }

  // ── replay ──────────────────────────────────────────────────────────────────

  async replay(options: EventReplayOptions = {}): Promise<EventMessage[]> {
    let results = this.eventLog as EventMessage[];

    // Apply timestamp bounds
    if (options.fromTimestamp !== undefined) {
      const from = options.fromTimestamp;
      results = results.filter((e) => e.timestamp >= from);
    }
    if (options.toTimestamp !== undefined) {
      const to = options.toTimestamp;
      results = results.filter((e) => e.timestamp <= to);
    }

    // Apply type filter
    if (options.types && options.types.length > 0) {
      const allowedTypes = options.types;
      results = results.filter((e) => allowedTypes.includes(e.type));
    }

    // Apply offset
    if (options.fromOffset !== undefined && options.fromOffset > 0) {
      results = results.slice(options.fromOffset);
    }

    // Apply limit
    if (options.limit !== undefined && options.limit > 0) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  // ── close ───────────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    this.subscriptions.clear();
    this.eventLog = [];
    this.emit("closed");
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates a new {@link InMemoryEventBus} instance.
 *
 * @example
 * ```ts
 * import { createInMemoryEventBus } from './InMemoryEventBus';
 * const bus = createInMemoryEventBus();
 * ```
 */
export function createInMemoryEventBus(): IEventBus {
  return new InMemoryEventBus();
}
