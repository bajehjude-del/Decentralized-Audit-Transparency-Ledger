/**
 * BridgeSubscriber
 *
 * Subscribes to the event bus and drives a cross-chain bridge handler.
 * Decouples the bridge relayer from downstream execution and provides
 * independent consumer group delivery guarantees.
 *
 * Supported event types:
 *   - contract.event_logged  -> handleEvent
 *   - contract.event_relayed -> handleRelayedEvent
 *   - contract.event_skipped -> handleSkippedEvent
 *   - contract.relay_error   -> handleRelayError
 */

import type { IEventBus, EventMessage, Subscription } from "../types";
import {
  EVENT_TYPES,
  type ContractEventPayload,
  type RelayedEventPayload,
  type SkippedEventPayload,
  type RelayErrorPayload,
} from "../publishers/RelayerPublisher";

// ── BridgeHandler Interface ───────────────────────────────────────────────────

export interface BridgeHandler {
  handleEvent(payload: ContractEventPayload): Promise<void>;
  handleRelayedEvent(payload: RelayedEventPayload): Promise<void>;
  handleSkippedEvent(payload: SkippedEventPayload): Promise<void>;
  handleRelayError(payload: RelayErrorPayload): Promise<void>;
}

// ── BridgeSubscriber ──────────────────────────────────────────────────────────

export class BridgeSubscriber {
  private subscription: Subscription | null = null;

  constructor(
    private readonly bus: IEventBus,
    private readonly handler: BridgeHandler,
  ) {}

  start(): void {
    if (this.subscription) return;

    this.subscription = this.bus.subscribe(
      Object.values(EVENT_TYPES),
      async (msg: EventMessage) => {
        switch (msg.type) {
          case EVENT_TYPES.CONTRACT_EVENT_LOGGED:
            await this.handler.handleEvent(msg.payload as ContractEventPayload);
            break;
          case EVENT_TYPES.CONTRACT_EVENT_RELAYED:
            await this.handler.handleRelayedEvent(msg.payload as RelayedEventPayload);
            break;
          case EVENT_TYPES.CONTRACT_EVENT_SKIPPED:
            await this.handler.handleSkippedEvent(msg.payload as SkippedEventPayload);
            break;
          case EVENT_TYPES.CONTRACT_RELAY_ERROR:
            await this.handler.handleRelayError(msg.payload as RelayErrorPayload);
            break;
        }
      },
      {
        groupId: "bridge-service",
        maxRetries: 3,
        retryDelay: 1000,
        dlq: true,
      },
    );

    console.log(`[BridgeSubscriber] subscribed (id=${this.subscription.id})`);
  }

  stop(): void {
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }
  }

  getSubscription(): Subscription | null {
    return this.subscription;
  }
}

export function createBridgeSubscriber(
  bus: IEventBus,
  handler: BridgeHandler,
): BridgeSubscriber {
  return new BridgeSubscriber(bus, handler);
}
