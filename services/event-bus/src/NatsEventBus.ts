/**
 * NatsEventBus — NATS JetStream-backed event bus.
 *
 * The `nats` package is loaded dynamically so this file compiles and can be
 * imported even when the package is not installed.  Attempting to instantiate
 * without the package throws a descriptive error at runtime.
 *
 * Architecture:
 *  - A single NATS connection is shared for publishing and subscribing.
 *  - Events are published to subject `{subjectPrefix}.{type}`.
 *  - A JetStream stream covers `{subjectPrefix}.>` to capture all types.
 *  - Durable consumers are created per `groupId`; ephemeral consumers are
 *    used when no `groupId` is supplied.
 *  - In-process routing via routeToSubscribers() runs alongside JetStream
 *    delivery for low-latency co-located consumers.
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

export interface NatsEventBusConfig {
  /** One or more NATS server URLs, e.g. `['nats://localhost:4222']`. */
  servers: string[];
  /** JetStream stream name. Default: 'AUDIT_EVENTS' */
  streamName?: string;
  /** Subject prefix. Events published to `{prefix}.{type}`. Default: 'audit.events' */
  subjectPrefix?: string;
}

// ── NatsEventBus ──────────────────────────────────────────────────────────────

export class NatsEventBus extends EventBusBase {
  private readonly config: Required<NatsEventBusConfig>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private nc: any = null; // NatsConnection
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private js: any = null; // JetStreamClient
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private jsm: any = null; // JetStreamManager
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sc: any = null; // StringCodec

  /** Resolves once the connection and stream are ready. */
  private readyPromise: Promise<void>;

  /** Active JetStream subscriptions keyed by subscription ID. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private jsSubs: Map<string, any> = new Map();

  private closed = false;

  constructor(config: NatsEventBusConfig) {
    super();

    // Fail fast if nats is not installed
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("nats");
    } catch {
      throw new Error(
        "Install nats to use NatsEventBus — run: npm install nats",
      );
    }

    this.config = {
      servers: config.servers,
      streamName: config.streamName ?? "AUDIT_EVENTS",
      subjectPrefix: config.subjectPrefix ?? "audit.events",
    };

    this.readyPromise = this.connect();
  }

  // ── Connection & stream setup ───────────────────────────────────────────────

  private async connect(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { connect, StringCodec } = require("nats");

    this.nc = await connect({ servers: this.config.servers });
    this.js = this.nc.jetstream();
    this.jsm = await this.nc.jetstreamManager();
    this.sc = StringCodec();

    // Ensure the stream exists and covers our subject prefix
    const subjectWildcard = `${this.config.subjectPrefix}.>`;
    try {
      await this.jsm.streams.add({
        name: this.config.streamName,
        subjects: [subjectWildcard],
        storage: "memory", // use 'file' in production
        retention: "limits",
        num_replicas: 1,
      });
    } catch (err: unknown) {
      // Stream already exists — update subjects if needed
      if (isStreamExistsError(err)) {
        const info = await this.jsm.streams.info(this.config.streamName);
        if (!info.config.subjects.includes(subjectWildcard)) {
          await this.jsm.streams.update(this.config.streamName, {
            ...info.config,
            subjects: [...info.config.subjects, subjectWildcard],
          });
        }
      } else {
        throw err;
      }
    }

    this.emit("connected");
  }

  // ── publish ─────────────────────────────────────────────────────────────────

  async publish(message: Omit<EventMessage, "id" | "timestamp">): Promise<void> {
    if (this.closed) throw new Error("NatsEventBus is closed");
    await this.readyPromise;

    const stamped: EventMessage = {
      ...{ version: 1 },
      ...message,
      id: this.generateId(),
      timestamp: Date.now(),
    };

    const subject = `${this.config.subjectPrefix}.${stamped.type}`;
    const payload = this.sc.encode(JSON.stringify(stamped));
    await this.js.publish(subject, payload);

    this.metrics.published++;

    // Also deliver in-process for low-latency co-located subscribers
    await this.routeToSubscribers(stamped);
  }

  // ── subscribe ───────────────────────────────────────────────────────────────

  subscribe(
    types: string | string[],
    handler: (msg: EventMessage) => Promise<void>,
    options: SubscriptionOptions = {},
  ): Subscription {
    const subscription = super.subscribe(types, handler, options);

    // Set up JetStream consumer asynchronously
    void this.createJetStreamConsumer(subscription.id, types, options);

    return subscription;
  }

  private async createJetStreamConsumer(
    subId: string,
    types: string | string[],
    options: SubscriptionOptions,
  ): Promise<void> {
    try {
      await this.readyPromise;

      const normalizedTypes = Array.isArray(types) ? types : [types];
      const groupId = options.groupId;

      // Build subject filter(s)
      const subjects = normalizedTypes.map(
        (t) => `${this.config.subjectPrefix}.${t}`,
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let jsSub: any;

      if (groupId) {
        // Durable consumer — survives reconnects
        const durableName = sanitizeDurableName(`${groupId}-${subId.slice(0, 8)}`);
        const consumerOpts = buildConsumerOpts(subjects, durableName);
        jsSub = await this.js.subscribe(subjects[0], consumerOpts);
      } else {
        // Ephemeral consumer
        const consumerOpts = buildConsumerOpts(subjects);
        jsSub = await this.js.subscribe(subjects[0], consumerOpts);
      }

      this.jsSubs.set(subId, jsSub);

      // Drain messages from the JetStream subscription
      void (async () => {
        for await (const m of jsSub) {
          if (this.closed) break;
          try {
            const decoded = this.sc.decode(m.data);
            const msg: EventMessage = JSON.parse(decoded);
            await this.routeToSubscribers(msg);
            m.ack();
          } catch {
            m.nak();
          }
        }
      })();
    } catch (err) {
      this.emit("error", err);
    }
  }

  // ── replay ──────────────────────────────────────────────────────────────────

  async replay(options: EventReplayOptions = {}): Promise<EventMessage[]> {
    await this.readyPromise;

    const messages: EventMessage[] = [];

    // Determine start position
    const consumerConfig: Record<string, unknown> = {
      filter_subject: `${this.config.subjectPrefix}.>`,
      ack_policy: "none",
      max_deliver: 1,
    };

    if (options.fromTimestamp !== undefined) {
      // opt_start_time expects RFC3339
      consumerConfig["opt_start_time"] = new Date(options.fromTimestamp).toISOString();
      consumerConfig["deliver_policy"] = "by_start_time";
    } else if (options.fromOffset !== undefined) {
      consumerConfig["opt_start_seq"] = options.fromOffset + 1; // 1-based
      consumerConfig["deliver_policy"] = "by_start_sequence";
    } else {
      consumerConfig["deliver_policy"] = "all";
    }

    const replayConsumer = await this.jsm.consumers.add(
      this.config.streamName,
      consumerConfig,
    );

    const fetchLimit =
      (options.limit ?? 0) + (options.fromOffset ?? 0) || 10_000;

    const sub = await this.js.fetch(
      this.config.streamName,
      replayConsumer.name,
      { max_messages: fetchLimit, expires: 5000 },
    );

    for await (const m of sub) {
      try {
        const decoded = this.sc.decode(m.data);
        const msg: EventMessage = JSON.parse(decoded);
        messages.push(msg);
        m.ack();
      } catch {
        // Skip malformed messages
      }
    }

    // Cleanup ephemeral replay consumer
    try {
      await this.jsm.consumers.delete(this.config.streamName, replayConsumer.name);
    } catch {
      // Best-effort cleanup
    }

    let results = messages;

    // Timestamp upper bound
    if (options.toTimestamp !== undefined) {
      const to = options.toTimestamp;
      results = results.filter((m) => m.timestamp <= to);
    }

    // Type filter
    if (options.types && options.types.length > 0) {
      const allowed = options.types;
      results = results.filter((m) => allowed.includes(m.type));
    }

    // Offset (already handled via opt_start_seq for NATS, but apply again for safety)
    if (options.fromOffset !== undefined && options.fromOffset > 0) {
      results = results.slice(options.fromOffset);
    }

    // Limit
    if (options.limit !== undefined && options.limit > 0) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  // ── close ───────────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    this.closed = true;

    // Unsubscribe from all JetStream consumers
    for (const jsSub of this.jsSubs.values()) {
      try {
        await jsSub.unsubscribe();
      } catch {
        // Best-effort
      }
    }
    this.jsSubs.clear();

    // Drain drains the connection and waits for pending publishes to complete
    if (this.nc) {
      await this.nc.drain();
    }

    this.subscriptions.clear();
    this.emit("closed");
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates a new {@link NatsEventBus} instance.
 *
 * Throws `'Install nats to use NatsEventBus'` if the nats package is not
 * installed.
 */
export function createNatsEventBus(config: NatsEventBusConfig): IEventBus {
  return new NatsEventBus(config);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** NATS durable consumer names may only contain alphanumeric chars and hyphens. */
function sanitizeDurableName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 255);
}

function buildConsumerOpts(
  subjects: string[],
  durableName?: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { consumerOpts } = require("nats");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opts: any = consumerOpts();
  opts.filterSubject(subjects[0]);
  opts.deliverAll();
  opts.ackExplicit();
  if (durableName) {
    opts.durable(durableName);
  } else {
    opts.ephemeral();
  }
  return opts;
}

function isStreamExistsError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes("stream name already in use") ||
      err.message.includes("already exists"))
  );
}
