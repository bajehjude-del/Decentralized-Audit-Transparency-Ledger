/**
 * audit-ledger-event-bus
 *
 * Public API — re-exports everything consumers need.
 */

// ── Types & interfaces ────────────────────────────────────────────────────────

export type {
  EventMessage,
  EventFilter,
  SubscriptionOptions,
  Subscription,
  DeadLetterEntry,
  EventBusMetrics,
  EventReplayOptions,
  EventBusBackend,
  IEventBus,
} from "./types";

// ── Base class (useful for custom implementations) ────────────────────────────

export { EventBusBase } from "./EventBusBase";

// ── In-memory implementation ──────────────────────────────────────────────────

export { InMemoryEventBus, createInMemoryEventBus } from "./InMemoryEventBus";

// ── Redis implementation ──────────────────────────────────────────────────────

export { RedisEventBus, createRedisEventBus } from "./RedisEventBus";
export type { RedisEventBusConfig } from "./RedisEventBus";

// ── NATS implementation ───────────────────────────────────────────────────────

export { NatsEventBus, createNatsEventBus } from "./NatsEventBus";
export type { NatsEventBusConfig } from "./NatsEventBus";

// ── Kafka implementation ──────────────────────────────────────────────────────

export { KafkaEventBus, createKafkaEventBus } from "./KafkaEventBus";
export type { KafkaEventBusConfig } from "./KafkaEventBus";

// ── Factory ───────────────────────────────────────────────────────────────────

export { createEventBus } from "./EventBusFactory";
export type { EventBusConfig } from "./EventBusFactory";

// ── Metrics reporter ──────────────────────────────────────────────────────────

export { EventBusMetricsReporter } from "./EventBusMetricsReporter";
export type { MetricsReporterConfig } from "./EventBusMetricsReporter";

// ── Publishers ────────────────────────────────────────────────────────────────

export {
  RelayerPublisher,
  createRelayerPublisher,
  EVENT_TYPES,
} from "./publishers/RelayerPublisher";
export type {
  RawContractEvent,
  ContractEventPayload,
  RelayedEventPayload,
  SkippedEventPayload,
  RelayErrorPayload,
  ContractEventType,
} from "./publishers/RelayerPublisher";

// ── Subscribers ───────────────────────────────────────────────────────────────

export {
  NotifierSubscriber,
  createNotifierSubscriber,
} from "./subscribers/NotifierSubscriber";
export type { NotifierLike } from "./subscribers/NotifierSubscriber";

export {
  AnalyticsSubscriber,
  InMemoryAnalyticsSink,
  createAnalyticsSubscriber,
} from "./subscribers/AnalyticsSubscriber";
export type {
  AnalyticsSink,
  AnalyticsRecord,
} from "./subscribers/AnalyticsSubscriber";

export {
  BridgeSubscriber,
  createBridgeSubscriber,
} from "./subscribers/BridgeSubscriber";
export type { BridgeHandler } from "./subscribers/BridgeSubscriber";
