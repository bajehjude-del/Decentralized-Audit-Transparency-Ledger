/**
 * EventBusFactory — creates the right IEventBus implementation.
 *
 * Backend selection order:
 *  1. `config.backend` (explicit argument)
 *  2. `EVENT_BUS_BACKEND` environment variable
 *  3. Defaults to 'memory'
 *
 * Recognised environment variables:
 *  - EVENT_BUS_BACKEND        'memory' | 'redis' | 'nats'
 *  - EVENT_BUS_REDIS_HOST     Redis hostname (default: 'localhost')
 *  - EVENT_BUS_REDIS_PORT     Redis port     (default: 6379)
 *  - EVENT_BUS_REDIS_PASSWORD Redis password (optional)
 *  - EVENT_BUS_NATS_SERVERS   Comma-separated NATS server URLs
 *                             (default: 'nats://localhost:4222')
 */

import { createInMemoryEventBus } from "./InMemoryEventBus";
import { createRedisEventBus } from "./RedisEventBus";
import { createNatsEventBus } from "./NatsEventBus";
import { createKafkaEventBus } from "./KafkaEventBus";
import type { IEventBus, EventBusBackend } from "./types";
import type { RedisEventBusConfig } from "./RedisEventBus";
import type { NatsEventBusConfig } from "./NatsEventBus";
import type { KafkaEventBusConfig } from "./KafkaEventBus";

// ── Config ────────────────────────────────────────────────────────────────────

export interface EventBusConfig {
  /** Which backend to use. */
  backend: EventBusBackend;
  /** Required when backend === 'redis'. */
  redis?: RedisEventBusConfig;
  /** Required when backend === 'nats'. */
  nats?: NatsEventBusConfig;
  /** Required when backend === 'kafka'. */
  kafka?: KafkaEventBusConfig;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates and returns an {@link IEventBus} instance.
 *
 * When `config` is omitted the factory reads environment variables to decide
 * which backend and connection parameters to use.
 *
 * @example
 * ```ts
 * // Explicit in-memory bus
 * const bus = createEventBus({ backend: 'memory' });
 *
 * // Redis bus from env vars
 * process.env.EVENT_BUS_BACKEND = 'redis';
 * process.env.EVENT_BUS_REDIS_HOST = 'my-redis.internal';
 * const bus = createEventBus();
 * ```
 */
export function createEventBus(config?: EventBusConfig): IEventBus {
  const backend = resolveBackend(config);

  switch (backend) {
    case "memory":
      return createInMemoryEventBus();

    case "redis": {
      const redisConfig = config?.redis ?? resolveRedisConfigFromEnv();
      return createRedisEventBus(redisConfig);
    }

    case "nats": {
      const natsConfig = config?.nats ?? resolveNatsConfigFromEnv();
      return createNatsEventBus(natsConfig);
    }

    case "kafka": {
      const kafkaConfig = config?.kafka ?? resolveKafkaConfigFromEnv();
      return createKafkaEventBus(kafkaConfig);
    }

    default: {
      // TypeScript exhaustiveness guard
      const _exhaustive: never = backend;
      throw new Error(`Unknown event bus backend: ${String(_exhaustive)}`);
    }
  }
}

// ── Env-var resolution helpers ────────────────────────────────────────────────

function resolveBackend(config?: EventBusConfig): EventBusBackend {
  if (config?.backend) return config.backend;

  const envBackend = process.env["EVENT_BUS_BACKEND"];
  if (
    envBackend === "redis" ||
    envBackend === "nats" ||
    envBackend === "kafka" ||
    envBackend === "memory"
  ) {
    return envBackend;
  }

  return "memory";
}

function resolveRedisConfigFromEnv(): RedisEventBusConfig {
  return {
    host: process.env["EVENT_BUS_REDIS_HOST"] ?? "localhost",
    port: parseInt(process.env["EVENT_BUS_REDIS_PORT"] ?? "6379", 10),
    password: process.env["EVENT_BUS_REDIS_PASSWORD"] ?? undefined,
  };
}

function resolveNatsConfigFromEnv(): NatsEventBusConfig {
  const serversEnv = process.env["EVENT_BUS_NATS_SERVERS"] ?? "nats://localhost:4222";
  const servers = serversEnv.split(",").map((s) => s.trim()).filter(Boolean);
  return { servers };
}

function resolveKafkaConfigFromEnv(): KafkaEventBusConfig {
  const brokersEnv = process.env["EVENT_BUS_KAFKA_BROKERS"] ?? "localhost:9092";
  const brokers = brokersEnv.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    brokers,
    clientId: process.env["EVENT_BUS_KAFKA_CLIENT_ID"],
    topic: process.env["EVENT_BUS_KAFKA_TOPIC"],
    groupId: process.env["EVENT_BUS_KAFKA_GROUP_ID"],
  };
}
