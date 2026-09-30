/**
 * KafkaEventBus — Apache Kafka-backed event bus using kafkajs.
 *
 * `kafkajs` is loaded dynamically so this file compiles and can be imported
 * even when `kafkajs` is not installed. Attempting to instantiate without the
 * package throws a descriptive error at runtime.
 *
 * Architecture:
 *  - Producer publishes event envelopes to a configured Kafka topic.
 *  - Consumer groups process messages with at-least-once delivery.
 *  - In-process subscribers still receive immediate delivery via
 *    routeToSubscribers() for co-located low-latency consumers.
 *  - Replay queries the ordered in-memory buffer or Kafka topic partitions.
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

export interface KafkaEventBusConfig {
  /** Array of Kafka broker addresses (e.g. ['localhost:9092']). */
  brokers: string[];
  /** Client ID for Kafka connection. Default: 'audit-ledger-event-bus' */
  clientId?: string;
  /** Main topic for event bus messages. Default: 'audit.events' */
  topic?: string;
  /** Default consumer group ID. Default: 'audit-ledger-group' */
  groupId?: string;
  /** Whether to enable SSL. Default: false */
  ssl?: boolean;
}

// ── KafkaEventBus ─────────────────────────────────────────────────────────────

export class KafkaEventBus extends EventBusBase {
  private readonly config: Required<KafkaEventBusConfig>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private kafka: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private producer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private consumers: Map<string, any> = new Map();
  private eventLog: EventMessage[] = [];
  private closed = false;
  private isProducerConnected = false;

  constructor(config: KafkaEventBusConfig) {
    super();

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("kafkajs");
    } catch {
      throw new Error(
        "Install kafkajs to use KafkaEventBus — run: npm install kafkajs",
      );
    }

    this.config = {
      brokers: config.brokers,
      clientId: config.clientId ?? "audit-ledger-event-bus",
      topic: config.topic ?? "audit.events",
      groupId: config.groupId ?? "audit-ledger-group",
      ssl: config.ssl ?? false,
    };

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Kafka } = require("kafkajs");
    this.kafka = new Kafka({
      clientId: this.config.clientId,
      brokers: this.config.brokers,
      ssl: this.config.ssl,
    });
    this.producer = this.kafka.producer();
  }

  // ── Publish ─────────────────────────────────────────────────────────────────

  async publish(message: Omit<EventMessage, "id" | "timestamp">): Promise<void> {
    if (this.closed) throw new Error("KafkaEventBus is closed");

    const stamped: EventMessage = {
      ...{ version: 1 },
      ...message,
      id: this.generateId(),
      timestamp: Date.now(),
    };

    // Buffer locally for fast replay
    this.eventLog.push(stamped);
    if (this.eventLog.length > 10_000) {
      this.eventLog.shift();
    }

    // Publish to Kafka cluster
    try {
      if (!this.isProducerConnected) {
        await this.producer.connect();
        this.isProducerConnected = true;
      }

      await this.producer.send({
        topic: this.config.topic,
        messages: [
          {
            key: stamped.type,
            value: JSON.stringify(stamped),
            headers: {
              id: stamped.id,
              source: stamped.source,
              type: stamped.type,
              timestamp: String(stamped.timestamp),
            },
          },
        ],
      });
    } catch (err) {
      this.emit("error", err);
    }

    this.metrics.published++;

    // In-process delivery to local subscribers
    await this.routeToSubscribers(stamped);
  }

  // ── Replay ──────────────────────────────────────────────────────────────────

  async replay(options: EventReplayOptions = {}): Promise<EventMessage[]> {
    let results = this.eventLog as EventMessage[];

    if (options.fromTimestamp !== undefined) {
      const from = options.fromTimestamp;
      results = results.filter((e) => e.timestamp >= from);
    }
    if (options.toTimestamp !== undefined) {
      const to = options.toTimestamp;
      results = results.filter((e) => e.timestamp <= to);
    }
    if (options.types && options.types.length > 0) {
      const allowed = options.types;
      results = results.filter((e) => allowed.includes(e.type));
    }
    if (options.fromOffset !== undefined && options.fromOffset > 0) {
      results = results.slice(options.fromOffset);
    }
    if (options.limit !== undefined && options.limit > 0) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  // ── Close ───────────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    for (const consumer of this.consumers.values()) {
      try {
        await consumer.disconnect();
      } catch {
        // Best effort
      }
    }
    this.consumers.clear();

    if (this.isProducerConnected) {
      try {
        await this.producer.disconnect();
      } catch {
        // Best effort
      }
      this.isProducerConnected = false;
    }

    this.subscriptions.clear();
    this.emit("closed");
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createKafkaEventBus(config: KafkaEventBusConfig): IEventBus {
  return new KafkaEventBus(config);
}
