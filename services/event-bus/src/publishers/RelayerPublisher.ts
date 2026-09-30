/**
 * RelayerPublisher
 *
 * Adapter that bridges the Stellar/EVM relayer's raw AuditEvent stream into
 * the decoupled IEventBus.  The relayer calls `publishContractEvent()` after
 * each successful poll; subscribers on the event bus receive a typed
 * `ContractEvent` payload without being coupled to the relayer internals.
 *
 * Supported event types:
 *   "contract.event_logged"    — a new event was logged on-chain
 *   "contract.event_relayed"   — proof was submitted to the EVM verifier
 *   "contract.event_skipped"   — event was filtered out by the relayer
 *   "contract.relay_error"     — an error occurred during relay
 *
 * Usage:
 *   const publisher = new RelayerPublisher(eventBus);
 *   // Inside the relayer poll loop:
 *   await publisher.publishContractEvent(rawStellarEvent);
 *   await publisher.publishRelayedEvent(rawStellarEvent, evmTxHash);
 */

import type { IEventBus, EventMessage } from "../types";

// ── Domain types ──────────────────────────────────────────────────────────────

/**
 * Raw event as returned by the Stellar RPC / contract polling loop.
 * Matches the shape used in bridge/relayer/index.ts.
 */
export interface RawContractEvent {
  index: number;
  timestamp: number;
  event_type: string;
  submitter: string;
  metadata: string;
  event_hash?: string;
  ledger_seq?: number;
  tx_hash?: string;
}

/**
 * Normalised payload published onto the event bus for every logged event.
 */
export interface ContractEventPayload {
  /** Original on-chain sequential index. */
  index: number;
  /** On-chain timestamp (Unix epoch seconds). */
  timestamp: number;
  /** Contract event type discriminator (e.g. "payment", "transfer"). */
  eventType: string;
  /** Address of the account that submitted the event. */
  submitter: string;
  /** Raw metadata bytes (hex string or decoded JSON). */
  metadata: string;
  /** Keccak-256 / SHA-256 hash of the event for proof generation. */
  eventHash?: string;
  /** Stellar ledger sequence number at which the event was recorded. */
  ledgerSeq?: number;
  /** Stellar transaction hash. */
  txHash?: string;
}

/**
 * Payload for "contract.event_relayed" — proof successfully submitted to EVM.
 */
export interface RelayedEventPayload extends ContractEventPayload {
  /** EVM transaction hash of the on-chain proof submission. */
  evmTxHash: string;
  /** EVM chain ID of the target network. */
  evmChainId?: string;
}

/**
 * Payload for "contract.event_skipped" — filtered by relayer rules.
 */
export interface SkippedEventPayload extends ContractEventPayload {
  /** Human-readable reason why the event was filtered. */
  reason: string;
}

/**
 * Payload for "contract.relay_error" — unrecoverable relay failure.
 */
export interface RelayErrorPayload {
  /** Error message. */
  error: string;
  /** Event index that triggered the error (when known). */
  eventIndex?: number;
  /** Raw event data (when available). */
  rawEvent?: RawContractEvent;
}

// ── Well-known type constants ─────────────────────────────────────────────────

export const EVENT_TYPES = {
  CONTRACT_EVENT_LOGGED: "contract.event_logged",
  CONTRACT_EVENT_RELAYED: "contract.event_relayed",
  CONTRACT_EVENT_SKIPPED: "contract.event_skipped",
  CONTRACT_RELAY_ERROR: "contract.relay_error",
} as const;

export type ContractEventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

// ── RelayerPublisher ──────────────────────────────────────────────────────────

export class RelayerPublisher {
  constructor(
    private readonly bus: IEventBus,
    private readonly source = "bridge-relayer",
  ) {}

  // ── Core helpers ────────────────────────────────────────────────────────────

  private normalise(raw: RawContractEvent): ContractEventPayload {
    return {
      index: raw.index,
      timestamp: raw.timestamp,
      eventType: raw.event_type,
      submitter: raw.submitter,
      metadata: raw.metadata,
      eventHash: raw.event_hash,
      ledgerSeq: raw.ledger_seq,
      txHash: raw.tx_hash,
    };
  }

  private baseEnvelope(
    type: ContractEventType,
    correlationId?: string,
  ): Omit<EventMessage, "id" | "timestamp" | "payload"> {
    return {
      type,
      source: this.source,
      version: 1,
      ...(correlationId ? { correlationId } : {}),
    };
  }

  // ── Publish methods ─────────────────────────────────────────────────────────

  /**
   * Publish a raw on-chain event to the bus as "contract.event_logged".
   *
   * Call this immediately after the relayer detects a new event on Stellar,
   * before proof generation.
   */
  async publishContractEvent(
    raw: RawContractEvent,
    correlationId?: string,
  ): Promise<void> {
    const payload: ContractEventPayload = this.normalise(raw);

    await this.bus.publish({
      ...this.baseEnvelope(EVENT_TYPES.CONTRACT_EVENT_LOGGED, correlationId),
      payload,
      metadata: {
        eventType: raw.event_type,
        ledgerSeq: raw.ledger_seq ?? null,
      },
    });
  }

  /**
   * Publish "contract.event_relayed" after a proof has been submitted to EVM.
   */
  async publishRelayedEvent(
    raw: RawContractEvent,
    evmTxHash: string,
    evmChainId?: string,
    correlationId?: string,
  ): Promise<void> {
    const payload: RelayedEventPayload = {
      ...this.normalise(raw),
      evmTxHash,
      evmChainId,
    };

    await this.bus.publish({
      ...this.baseEnvelope(EVENT_TYPES.CONTRACT_EVENT_RELAYED, correlationId),
      payload,
      metadata: { evmTxHash, evmChainId: evmChainId ?? null },
    });
  }

  /**
   * Publish "contract.event_skipped" when the relayer's filter rejects an event.
   */
  async publishSkippedEvent(
    raw: RawContractEvent,
    reason: string,
    correlationId?: string,
  ): Promise<void> {
    const payload: SkippedEventPayload = {
      ...this.normalise(raw),
      reason,
    };

    await this.bus.publish({
      ...this.baseEnvelope(EVENT_TYPES.CONTRACT_EVENT_SKIPPED, correlationId),
      payload,
      metadata: { reason },
    });
  }

  /**
   * Publish "contract.relay_error" on relay failures.
   */
  async publishRelayError(
    error: Error | string,
    raw?: RawContractEvent,
    correlationId?: string,
  ): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : error;
    const payload: RelayErrorPayload = {
      error: errorMessage,
      eventIndex: raw?.index,
      rawEvent: raw,
    };

    await this.bus.publish({
      ...this.baseEnvelope(EVENT_TYPES.CONTRACT_RELAY_ERROR, correlationId),
      payload,
      metadata: { error: errorMessage },
    });
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates a new RelayerPublisher bound to the given event bus.
 *
 * @example
 * ```ts
 * import { createEventBus } from '../EventBusFactory';
 * import { createRelayerPublisher } from './RelayerPublisher';
 *
 * const bus = createEventBus();
 * const publisher = createRelayerPublisher(bus);
 * await publisher.publishContractEvent(rawEvent);
 * ```
 */
export function createRelayerPublisher(
  bus: IEventBus,
  source?: string,
): RelayerPublisher {
  return new RelayerPublisher(bus, source);
}
