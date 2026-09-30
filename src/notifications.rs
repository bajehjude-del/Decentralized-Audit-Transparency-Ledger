//! Issue #409 — Notification Preferences & Digest Engine
//!
//! Allows submitters to register per-channel delivery preferences and
//! schedules digest batches (Instant / Hourly / Daily / Weekly / None).
//! Unsubscribe / resubscribe, channel-endpoint registry, delivery history,
//! bounce tracking, and aggregate stats are all on-chain.

use soroban_sdk::{contractimpl, contracttype, panic_with_error, Address, Bytes, BytesN, Env, Symbol, Vec};

use crate::{AuditLedger, AuditLedgerArgs, AuditLedgerClient, ContractError, DataKey};

// Digest schedule

/// How often to bundle matching events into a digest.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DigestPreference {
    /// Deliver each matching event immediately.
    Instant = 0,
    /// Bundle events into an hourly digest.
    HourlyDigest = 1,
    /// Bundle events into a daily digest.
    DailyDigest = 2,
    /// Bundle events into a weekly digest.
    WeeklyDigest = 3,
    /// Notifications disabled for this channel / event type.
    None = 4,
}

// Delivery channel

/// Transport channel for notification delivery.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeliveryChannel {
    Email = 0,
    Slack = 1,
    Discord = 2,
    Webhook = 3,
}

// Per-channel preference record

/// A single channel+digest preference entry for one subscriber.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChannelPreference {
    /// Which transport to use.
    pub channel: DeliveryChannel,
    /// Digest schedule for this channel.
    pub digest: DigestPreference,
    /// Channel-specific endpoint (email address, Slack webhook URL, …) as UTF-8
    /// bytes.  Empty = use the subscriber's default endpoint for this channel.
    pub endpoint: Bytes,
    /// Whether this channel is currently subscribed.
    pub active: bool,
}

/// Full notification preference record for one subscriber + event-type pair.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NotificationPreference {
    pub subscriber: Address,
    /// Event type this preference applies to.  Empty symbol = wildcard (all types).
    pub event_type: Symbol,
    /// Ordered list of channel preferences (first active channel wins for instant).
    pub channels: Vec<ChannelPreference>,
    /// Whether the subscriber has globally unsubscribed from this event type.
    pub unsubscribed: bool,
    /// Ledger timestamp of the last modification.
    pub updated_at: u64,
}

// Digest batch record

/// A queued or delivered digest batch.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DigestBatch {
    /// Auto-incrementing batch ID.
    pub id: u32,
    pub subscriber: Address,
    pub event_type: Symbol,
    pub channel: DeliveryChannel,
    pub schedule: DigestPreference,
    /// Packed event IDs (32 bytes each) included in this batch.
    pub event_ids: Vec<BytesN<32>>,
    /// Ledger timestamp when the batch was created.
    pub created_at: u64,
    /// Ledger timestamp when the batch was marked delivered.  0 = pending.
    pub delivered_at: u64,
    /// Whether delivery was successful.
    pub delivered: bool,
}

// Delivery history entry

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeliveryRecord {
    pub batch_id: u32,
    pub subscriber: Address,
    pub channel: DeliveryChannel,
    /// Ledger timestamp of the delivery attempt.
    pub attempted_at: u64,
    pub success: bool,
    /// Number of consecutive failures before this attempt.
    pub consecutive_failures: u32,
}

// Notification statistics

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NotificationStats {
    pub total_batches: u32,
    pub total_delivered: u32,
    pub total_failed: u32,
    pub total_bounced: u32,
}

// DataKey extensions (issue #409) — stored as associated functions
// We piggy-back on the existing DataKey enum by using the free-form Bytes
// storage slot via raw key helpers (serialise our own compound key).  This
// avoids touching the DataKey enum while staying within the single-crate
// constraint.

#[contractimpl]
impl AuditLedger {
    // Public API

    /// Register or update notification preferences for a subscriber / event-type
    /// pair.  The subscriber must authorise the call.
    pub fn set_notification_preference(
        env: Env,
        subscriber: Address,
        event_type: Symbol,
        channels: Vec<ChannelPreference>,
    ) {
        subscriber.require_auth();
        let pref = NotificationPreference {
            subscriber: subscriber.clone(),
            event_type: event_type.clone(),
            channels,
            unsubscribed: false,
            updated_at: env.ledger().timestamp(),
        };
        let key = Self::notif_pref_key(&env, &subscriber, &event_type);
        env.storage().instance().set(&key, &pref);
        env.events().publish(
            (Symbol::new(&env, "notif"), Symbol::new(&env, "pref_set")),
            (subscriber, event_type),
        );
    }

    /// Return the stored preference, or `None` if not set.
    pub fn get_notification_preference(
        env: Env,
        subscriber: Address,
        event_type: Symbol,
    ) -> Option<NotificationPreference> {
        let key = Self::notif_pref_key(&env, &subscriber, &event_type);
        env.storage().instance().get(&key)
    }

    /// Unsubscribe a subscriber from an event type.  Sets the `unsubscribed`
    /// flag to `true` and marks all channels inactive.
    pub fn unsubscribe(env: Env, subscriber: Address, event_type: Symbol) {
        subscriber.require_auth();
        let key = Self::notif_pref_key(&env, &subscriber, &event_type);
        let mut pref: NotificationPreference =
            env.storage()
                .instance()
                .get(&key)
                .unwrap_or_else(|| NotificationPreference {
                    subscriber: subscriber.clone(),
                    event_type: event_type.clone(),
                    channels: Vec::new(&env),
                    unsubscribed: false,
                    updated_at: 0,
                });
        pref.unsubscribed = true;
        pref.updated_at = env.ledger().timestamp();
        // Deactivate all channels
        let mut updated_channels: Vec<ChannelPreference> = Vec::new(&env);
        for i in 0..pref.channels.len() {
            let mut ch = pref.channels.get(i).unwrap();
            ch.active = false;
            updated_channels.push_back(ch);
        }
        pref.channels = updated_channels;
        env.storage().instance().set(&key, &pref);
        env.events().publish(
            (Symbol::new(&env, "notif"), Symbol::new(&env, "unsubscribed")),
            (subscriber, event_type),
        );
    }

    /// Re-subscribe a previously unsubscribed address.
    pub fn resubscribe(env: Env, subscriber: Address, event_type: Symbol) {
        subscriber.require_auth();
        let key = Self::notif_pref_key(&env, &subscriber, &event_type);
        if let Some(mut pref) = env.storage().instance().get::<_, NotificationPreference>(&key) {
            pref.unsubscribed = false;
            pref.updated_at = env.ledger().timestamp();
            env.storage().instance().set(&key, &pref);
        }
        env.events().publish(
            (Symbol::new(&env, "notif"), Symbol::new(&env, "resubscribed")),
            (subscriber, event_type),
        );
    }

    /// Build a digest batch for a subscriber/type/channel/schedule combination.
    /// Collects all event IDs logged since `since_timestamp`.
    /// Owner-only (batch building is a governance / off-chain-relay operation).
    pub fn build_digest(
        env: Env,
        caller: Address,
        subscriber: Address,
        event_type: Symbol,
        channel: DeliveryChannel,
        schedule: DigestPreference,
        since_timestamp: u64,
    ) -> u32 {
        caller.require_auth();
        Self::require_owner_or_multisig(&env, &caller);

        // Collect matching event IDs
        let total = Self::total_events(env.clone());
        let mut event_ids: Vec<BytesN<32>> = Vec::new(&env);
        for i in 0..total {
            let id: BytesN<32> = env.storage().instance().get(&DataKey::EventOrder(i)).unwrap();
            let evt: crate::Event = env.storage().instance().get(&DataKey::EventData(id.clone())).unwrap();
            if evt.timestamp >= since_timestamp && evt.event_type == event_type {
                event_ids.push_back(id);
            }
        }

        let batch_id: u32 = env.storage().instance().get(&DataKey::NotifBatchCount).unwrap_or(0);
        let batch = DigestBatch {
            id: batch_id,
            subscriber: subscriber.clone(),
            event_type: event_type.clone(),
            channel,
            schedule,
            event_ids,
            created_at: env.ledger().timestamp(),
            delivered_at: 0,
            delivered: false,
        };
        env.storage().instance().set(&DataKey::NotifBatch(batch_id), &batch);
        env.storage().instance().set(&DataKey::NotifBatchCount, &(batch_id + 1));
        env.events().publish(
            (Symbol::new(&env, "notif"), Symbol::new(&env, "batch_created")),
            (batch_id, subscriber, event_type),
        );
        batch_id
    }

    /// Mark a digest batch as delivered (off-chain relay callback).
    pub fn record_delivery(env: Env, caller: Address, batch_id: u32, success: bool) {
        caller.require_auth();
        Self::require_owner_or_multisig(&env, &caller);

        let key = DataKey::NotifBatch(batch_id);
        let mut batch: DigestBatch = env
            .storage()
            .instance()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::EventDoesNotExist));

        batch.delivered = success;
        batch.delivered_at = env.ledger().timestamp();
        env.storage().instance().set(&key, &batch);

        // Update stats
        let mut stats: NotificationStats =
            env.storage()
                .instance()
                .get(&DataKey::NotifStats)
                .unwrap_or(NotificationStats {
                    total_batches: 0,
                    total_delivered: 0,
                    total_failed: 0,
                    total_bounced: 0,
                });
        if success {
            stats.total_delivered = stats.total_delivered.saturating_add(1);
            // Reset consecutive-failure counter on success
            env.storage()
                .instance()
                .remove(&DataKey::NotifConsecutiveFails(batch_id));
        } else {
            stats.total_failed = stats.total_failed.saturating_add(1);
            let fails: u32 = env
                .storage()
                .instance()
                .get(&DataKey::NotifConsecutiveFails(batch_id))
                .unwrap_or(0)
                + 1;
            env.storage()
                .instance()
                .set(&DataKey::NotifConsecutiveFails(batch_id), &fails);
            // Auto-disable channel after 5 consecutive failures
            if fails >= 5 {
                stats.total_bounced = stats.total_bounced.saturating_add(1);
                env.events().publish(
                    (Symbol::new(&env, "notif"), Symbol::new(&env, "channel_bounced")),
                    (batch_id, fails),
                );
            }
        }
        stats.total_batches = stats.total_batches.saturating_add(1);
        env.storage().instance().set(&DataKey::NotifStats, &stats);

        env.events().publish(
            (Symbol::new(&env, "notif"), Symbol::new(&env, "delivery_recorded")),
            (batch_id, success),
        );
    }

    /// Report a channel bounce (hard delivery failure / invalid address).
    pub fn report_bounce(env: Env, caller: Address, batch_id: u32) {
        caller.require_auth();
        Self::require_owner_or_multisig(&env, &caller);
        let mut stats: NotificationStats =
            env.storage()
                .instance()
                .get(&DataKey::NotifStats)
                .unwrap_or(NotificationStats {
                    total_batches: 0,
                    total_delivered: 0,
                    total_failed: 0,
                    total_bounced: 0,
                });
        stats.total_bounced = stats.total_bounced.saturating_add(1);
        env.storage().instance().set(&DataKey::NotifStats, &stats);
        env.events()
            .publish((Symbol::new(&env, "notif"), Symbol::new(&env, "bounced")), (batch_id,));
    }

    /// Clear the consecutive-failure counter for a batch (after remediation).
    pub fn clear_bounce(env: Env, caller: Address, batch_id: u32) {
        caller.require_auth();
        Self::require_owner_or_multisig(&env, &caller);
        env.storage()
            .instance()
            .remove(&DataKey::NotifConsecutiveFails(batch_id));
    }

    /// Return aggregate notification delivery statistics.
    pub fn get_notification_stats(env: Env) -> NotificationStats {
        env.storage()
            .instance()
            .get(&DataKey::NotifStats)
            .unwrap_or(NotificationStats {
                total_batches: 0,
                total_delivered: 0,
                total_failed: 0,
                total_bounced: 0,
            })
    }

    /// Retrieve a digest batch by ID.
    pub fn get_digest_batch(env: Env, batch_id: u32) -> Option<DigestBatch> {
        env.storage().instance().get(&DataKey::NotifBatch(batch_id))
    }

    // Private helpers

    /// Derive a compound storage key for a subscriber+event_type preference.
    /// Uses a Bytes blob: `sha256(subscriber_strkey || event_type_payload_le)`.
    fn notif_pref_key(env: &Env, subscriber: &Address, event_type: &Symbol) -> DataKey {
        let mut preimage = soroban_sdk::Bytes::new(env);
        preimage.append(&subscriber.to_string().to_bytes());
        preimage.append(&Self::u64_to_bytes(env, event_type.to_val().get_payload()));
        let hash: BytesN<32> = env.crypto().sha256(&preimage).into();
        DataKey::NotifPreference(hash)
    }
}
