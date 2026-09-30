/**
 * RedisEventBus — Redis Streams-backed event bus using ioredis.
 *
 * ioredis is loaded dynamically so this file compiles (and can be imported)
 * even when ioredis is not installed.  Attempting to instantiate without the
 * package will throw a descriptive error at runtime.
 *
 * Architecture:
 *  - Events are written to a Redis Stream (XADD) with a configurable key
 *    and capped length (MAXLEN ~).
 *  - Each consumer group (derived from `groupId`) reads via XREADGROUP.
 *  - In-process subscribers still receive immediate delivery via
 *    routeToSubscribers() so latency is low for co-located consumers.
 *  - Replay uses XRANGE with millisecond-epoch-based Redis stream IDs.
 */

import { EventBusBase } from "./EventBusBase";
import type {
  EventMessage,
  EventReplayOptions,
  IEventBus,
  Subscription,
  SubscriptionOptions,
} from "./types";

// ── Config ────────────────────────────────────────────────────────────────────

export interface RedisEventBusConfig {
  host: string;
  port: number;
  password?: string;
  /** Prefix applied to all Redis keys. Default: '' */
  keyPrefix?: string;
  /** Name of the Redis Stream. Default: 'audit:events' */
  streamName?: string;
  /** Soft cap on stream length (MAXLEN ~). Default: 100_000 */
  maxStreamLength?: number;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface PollingLoop {
  /** Resolves when the loop should stop. */
  stop(): void;
  /** Promise that resolves when the loop has fully exited. */
  done: Promise<void>;
}

// ── RedisEventBus ─────────────────────────────────────────────────────────────

export class RedisEventBus extends EventBusBase {
  private readonly config: Required<RedisEventBusConfig>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private publisher!: any; // ioredis Redis instance
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private subscriber!: any; // ioredis Redis instance (separate connection for blocking reads)
  private pollingLoops: Map<string, PollingLoop> = new Map();
  private closed = false;

  constructor(config: RedisEventBusConfig) {
    super();

    // Ensure ioredis is available before doing anything else
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("ioredis");
    } catch {
      throw new Error(
        "Install ioredis to use RedisEventBus — run: npm install ioredis",
      );
    }

    this.config = {
      host: config.host,
      port: config.port,
      password: config.password ?? "",
      keyPrefix: config.keyPrefix ?? "",
      streamName: config.streamName ?? "audit:events",
      maxStreamLength: config.maxStreamLength ?? 100_000,
    };

    this.initConnections();
  }

  // ── Connection setup ────────────────────────────────────────────────────────

  private initConnections(): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Redis = require("ioredis");
    const opts = {
      host: this.config.host,
      port: this.config.port,
      ...(this.config.password ? { password: this.config.password } : {}),
      keyPrefix: this.config.keyPrefix,
      lazyConnect: false,
    };
    this.publisher = new Redis(opts);
    this.subscriber = new Redis(opts);

    this.publisher.on("error", (err: Error) => this.emit("error", err));
    this.subscriber.on("error", (err: Error) => this.emit("error", err));
  }

  private get streamKey(): string {
    return this.config.streamName;
  }

  // ── publish ─────────────────────────────────────────────────────────────────

  async publish(message: Omit<EventMessage, "id" | "timestamp">): Promise<void> {
    if (this.closed) throw new Error("RedisEventBus is closed");

    const stamped: EventMessage = {
      ...{ version: 1 },
      ...message,
      id: this.generateId(),
      timestamp: Date.now(),
    };

    const payload = JSON.stringify(stamped);

    // Write to Redis Stream — '*' lets Redis auto-assign a monotonic ID
    await this.publisher.xadd(
      this.streamKey,
      "MAXLEN",
      "~",
      this.config.maxStreamLength,
      "*",
      "data",
      payload,
    );

    this.metrics.published++;

    // Also deliver in-process so co-located subscribers don't incur polling lag
    await this.routeToSubscribers(stamped);
  }

  // ── subscribe ───────────────────────────────────────────────────────────────

  subscribe(
    types: string | string[],
    handler: (msg: EventMessage) => Promise<void>,
    options: SubscriptionOptions = {},
  ): Subscription {
    const subscription = super.subscribe(types, handler, options);

    // If a groupId is specified, start a consumer-group polling loop
    const groupId = options.groupId;
    if (groupId && !this.pollingLoops.has(groupId)) {
      const loop = this.startConsumerGroupLoop(groupId, subscription.id);
      this.pollingLoops.set(groupId, loop);
    }

    return subscription;
  }

  // ── Consumer-group polling loop ─────────────────────────────────────────────

  private startConsumerGroupLoop(groupId: string, consumerId: string): PollingLoop {
    let active = true;

    const done = (async () => {
      // Create group if it does not exist yet (MKSTREAM creates the stream too)
      try {
        await this.subscriber.xgroup(
          "CREATE",
          this.streamKey,
          groupId,
          "$", // only new messages
          "MKSTREAM",
        );
      } catch (err: unknown) {
        // BUSYGROUP means the group already exists — that's fine
        if (!isBusyGroupError(err)) {
          this.emit("error", err);
        }
      }

      while (active && !this.closed) {
        try {
          // Block for up to 1 second waiting for new messages
          const results: Array<[string, Array<[string, string[]]>]> =
            await this.subscriber.xreadgroup(
              "GROUP",
              groupId,
              consumerId,
              "COUNT",
              10,
              "BLOCK",
              1000,
              "STREAMS",
              this.streamKey,
              ">",
            );

          if (!results) continue;

          for (const [, entries] of results) {
            for (const [streamId, fields] of entries) {
              const dataIndex = fields.indexOf("data");
              if (dataIndex === -1) continue;
              const raw = fields[dataIndex + 1];
              try {
                const msg: EventMessage = JSON.parse(raw);
                await this.routeToSubscribers(msg);
                // Acknowledge after successful delivery
                await this.subscriber.xack(this.streamKey, groupId, streamId);
              } catch {
                // Failed to parse or route — leave unacknowledged for replay
              }
            }
          }
        } catch (err) {
          if (active && !this.closed) {
            this.emit("error", err);
            await sleep(500);
          }
        }
      }
    })();

    return {
      stop() { active = false; },
      done,
    };
  }

  // ── replay ──────────────────────────────────────────────────────────────────

  async replay(options: EventReplayOptions = {}): Promise<EventMessage[]> {
    // Build Redis stream ID bounds from timestamp options.
    // Redis stream IDs are "<milliseconds>-<sequence>".
    const start = options.fromTimestamp !== undefined
      ? `${options.fromTimestamp}-0`
      : "-";
    const end = options.toTimestamp !== undefined
      ? `${options.toTimestamp}-${Number.MAX_SAFE_INTEGER}`
      : "+";

    // Fetch up to limit + fromOffset entries (we apply offset after)
    const fetchCount = ((options.limit ?? 0) + (options.fromOffset ?? 0)) || 1000;

    const entries: Array<[string, string[]]> = await this.publisher.xrange(
      this.streamKey,
      start,
      end,
      "COUNT",
      fetchCount,
    );

    let messages: EventMessage[] = [];

    for (const [, fields] of entries) {
      const dataIndex = fields.indexOf("data");
      if (dataIndex === -1) continue;
      try {
        const msg: EventMessage = JSON.parse(fields[dataIndex + 1]);
        messages.push(msg);
      } catch {
        // Skip malformed entries
      }
    }

    // Type filter
    if (options.types && options.types.length > 0) {
      const allowed = options.types;
      messages = messages.filter((m) => allowed.includes(m.type));
    }

    // Offset
    if (options.fromOffset !== undefined && options.fromOffset > 0) {
      messages = messages.slice(options.fromOffset);
    }

    // Limit
    if (options.limit !== undefined && options.limit > 0) {
      messages = messages.slice(0, options.limit);
    }

    return messages;
  }

  // ── close ───────────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    this.closed = true;

    // Stop all polling loops and wait for them to drain
    const stopPromises: Promise<void>[] = [];
    for (const loop of this.pollingLoops.values()) {
      loop.stop();
      stopPromises.push(loop.done);
    }
    await Promise.all(stopPromises);
    this.pollingLoops.clear();

    // Close Redis connections
    this.publisher.disconnect();
    this.subscriber.disconnect();

    this.subscriptions.clear();
    this.emit("closed");
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates a new {@link RedisEventBus} instance.
 *
 * Throws `'Install ioredis to use RedisEventBus'` if ioredis is not installed.
 */
export function createRedisEventBus(config: RedisEventBusConfig): IEventBus {
  return new RedisEventBus(config);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBusyGroupError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes("BUSYGROUP") || err.message.includes("already exists"))
  );
}
