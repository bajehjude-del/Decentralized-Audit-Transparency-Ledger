/**
 * NotifierSubscriber
 *
 * Subscribes to the event bus and drives the existing Notifier service.
 * This decouples the Notifier from its direct WebSocket connection —
 * events from any source (relayer, webhook, API) can now trigger notifications
 * as long as they flow through the event bus.
 *
 * Architecture:
 *   EventBus ──► NotifierSubscriber ──► Notifier.processEvent()
 *                                            ├─► Slack
 *                                            ├─► Telegram
 *                                            ├─► Webhook
 *                                            └─► Email
 *
 * Usage:
 *   const subscriber = new NotifierSubscriber(bus, notifier);
 *   subscriber.start();
 *   // …
 *   subscriber.stop();
 */

import type { IEventBus, EventMessage, Subscription } from "../types";
import type { ContractEventPayload } from "../publishers/RelayerPublisher";
import { EVENT_TYPES } from "../publishers/RelayerPublisher";

// ── Minimal Notifier interface ────────────────────────────────────────────────

/**
 * The subset of the Notifier API that NotifierSubscriber depends on.
 * Using a structural interface keeps this module free of a hard import
 * from the notifier package.
 */
export interface NotifierLike {
  processEvent(event: {
    index: number;
    timestamp: number;
    event_type: string;
    submitter: string;
    metadata: string;
  }): Promise<void>;
}

// ── NotifierSubscriber ────────────────────────────────────────────────────────

export class NotifierSubscriber {
  private subscription: Subscription | null = null;

  constructor(
    private readonly bus: IEventBus,
    private readonly notifier: NotifierLike,
  ) {}

  /**
   * Starts listening for "contract.event_logged" messages on the bus
   * and forwards them to the notifier.
   *
   * Call this once during service startup.
   */
  start(): void {
    if (this.subscription) {
      console.warn("[NotifierSubscriber] already started — ignoring duplicate start()");
      return;
    }

    this.subscription = this.bus.subscribe(
      [EVENT_TYPES.CONTRACT_EVENT_LOGGED, EVENT_TYPES.CONTRACT_EVENT_RELAYED],
      async (msg: EventMessage) => {
        const payload = msg.payload as ContractEventPayload;

        await this.notifier.processEvent({
          index: payload.index,
          timestamp: payload.timestamp,
          event_type: payload.eventType,
          submitter: payload.submitter,
          metadata: payload.metadata,
        });
      },
      {
        groupId: "notifier-service",
        maxRetries: 3,
        retryDelay: 500,
        dlq: true,
      },
    );

    console.log(`[NotifierSubscriber] subscribed (id=${this.subscription.id})`);
  }

  /**
   * Cancels the event bus subscription.
   */
  stop(): void {
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
      console.log("[NotifierSubscriber] stopped");
    }
  }

  get subscriptionId(): string | null {
    return this.subscription?.id ?? null;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createNotifierSubscriber(
  bus: IEventBus,
  notifier: NotifierLike,
): NotifierSubscriber {
  return new NotifierSubscriber(bus, notifier);
}
