use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{symbol_short, Address, Bytes, Env, Symbol, Vec};

use crate::notifications::{ChannelPreference, DeliveryChannel, DigestPreference};

fn create_ledger() -> (Env, Address, AuditLedgerClient<'static>) {
    let env = Env::default();
    let owner = Address::generate(&env);
    let contract_id = env.register(AuditLedger, ());
    let client = AuditLedgerClient::new(&env, &contract_id);
    env.mock_all_auths_allowing_non_root_auth();
    let mut owners = Vec::new(&env);
    owners.push_back(owner.clone());
    client.initialize(&owners, &1000, &4096);
    (env, owner, client)
}

// ── Preference set / get ──────────────────────────────────────────────────────

#[test]
fn set_and_get_notification_preference() {
    let (env, _owner, client) = create_ledger();
    let sub = Address::generate(&env);

    let mut channels = Vec::new(&env);
    channels.push_back(ChannelPreference {
        channel: DeliveryChannel::Email,
        digest: DigestPreference::DailyDigest,
        endpoint: Bytes::from_slice(&env, b"alice@example.com"),
        active: true,
    });

    client.set_notification_preference(&sub, &symbol_short!("payment"), &channels);

    let pref = client
        .get_notification_preference(&sub, &symbol_short!("payment"))
        .unwrap();
    assert_eq!(pref.subscriber, sub);
    assert!(!pref.unsubscribed);
    assert_eq!(pref.channels.len(), 1);
    assert_eq!(pref.channels.get(0).unwrap().digest, DigestPreference::DailyDigest);
}

#[test]
fn missing_preference_returns_none() {
    let (env, _owner, client) = create_ledger();
    let sub = Address::generate(&env);
    let result = client.get_notification_preference(&sub, &symbol_short!("missing"));
    assert!(result.is_none());
}

// ── Unsubscribe / resubscribe ─────────────────────────────────────────────────

#[test]
fn unsubscribe_sets_flag_and_deactivates_channels() {
    let (env, _owner, client) = create_ledger();
    let sub = Address::generate(&env);

    let mut channels = Vec::new(&env);
    channels.push_back(ChannelPreference {
        channel: DeliveryChannel::Slack,
        digest: DigestPreference::Instant,
        endpoint: Bytes::from_slice(&env, b"https://hooks.slack.com/test"),
        active: true,
    });
    client.set_notification_preference(&sub, &symbol_short!("audit"), &channels);
    client.unsubscribe(&sub, &symbol_short!("audit"));

    let pref = client
        .get_notification_preference(&sub, &symbol_short!("audit"))
        .unwrap();
    assert!(pref.unsubscribed);
    for i in 0..pref.channels.len() {
        assert!(!pref.channels.get(i).unwrap().active);
    }
}

#[test]
fn resubscribe_clears_unsubscribed_flag() {
    let (env, _owner, client) = create_ledger();
    let sub = Address::generate(&env);

    let mut channels = Vec::new(&env);
    channels.push_back(ChannelPreference {
        channel: DeliveryChannel::Email,
        digest: DigestPreference::WeeklyDigest,
        endpoint: Bytes::from_slice(&env, b"bob@example.com"),
        active: true,
    });
    client.set_notification_preference(&sub, &symbol_short!("report"), &channels);
    client.unsubscribe(&sub, &symbol_short!("report"));
    client.resubscribe(&sub, &symbol_short!("report"));

    let pref = client
        .get_notification_preference(&sub, &symbol_short!("report"))
        .unwrap();
    assert!(!pref.unsubscribed);
}

// ── Digest batch build / deliver ──────────────────────────────────────────────

#[test]
fn build_digest_creates_batch_with_matching_events() {
    let (env, owner, client) = create_ledger();
    let sub = Address::generate(&env);
    let submitter = Address::generate(&env);

    // Log some events
    client.log_event(
        &submitter,
        &symbol_short!("payment"),
        &Bytes::from_slice(&env, b"tx1"),
        &None,
        &None,
        &false,
    );
    client.log_event(
        &submitter,
        &symbol_short!("payment"),
        &Bytes::from_slice(&env, b"tx2"),
        &None,
        &None,
        &true,
    );
    client.log_event(
        &submitter,
        &symbol_short!("other"),
        &Bytes::from_slice(&env, b"tx3"),
        &None,
        &None,
        &true,
    );

    let batch_id = client.build_digest(
        &owner,
        &sub,
        &symbol_short!("payment"),
        &DeliveryChannel::Email,
        &DigestPreference::DailyDigest,
        &0u64,
    );

    let batch = client.get_digest_batch(&batch_id).unwrap();
    assert_eq!(batch.subscriber, sub);
    assert_eq!(batch.event_ids.len(), 2); // only payment events
    assert!(!batch.delivered);
}

#[test]
fn record_delivery_marks_batch_delivered() {
    let (env, owner, client) = create_ledger();
    let sub = Address::generate(&env);

    let batch_id = client.build_digest(
        &owner,
        &sub,
        &symbol_short!("payment"),
        &DeliveryChannel::Email,
        &DigestPreference::Instant,
        &0u64,
    );

    client.record_delivery(&owner, &batch_id, &true);
    let batch = client.get_digest_batch(&batch_id).unwrap();
    assert!(batch.delivered);
}

#[test]
fn record_delivery_failure_increments_stats() {
    let (env, owner, client) = create_ledger();
    let sub = Address::generate(&env);

    let batch_id = client.build_digest(
        &owner,
        &sub,
        &symbol_short!("audit"),
        &DeliveryChannel::Webhook,
        &DigestPreference::HourlyDigest,
        &0u64,
    );

    client.record_delivery(&owner, &batch_id, &false);
    let stats = client.get_notification_stats();
    assert_eq!(stats.total_failed, 1);
}

// ── Bounce tracking ───────────────────────────────────────────────────────────

#[test]
fn report_bounce_increments_bounced_count() {
    let (env, owner, client) = create_ledger();
    let sub = Address::generate(&env);

    let batch_id = client.build_digest(
        &owner,
        &sub,
        &symbol_short!("audit"),
        &DeliveryChannel::Discord,
        &DigestPreference::WeeklyDigest,
        &0u64,
    );

    client.report_bounce(&owner, &batch_id);
    let stats = client.get_notification_stats();
    assert_eq!(stats.total_bounced, 1);
}

#[test]
fn clear_bounce_removes_failure_counter() {
    let (env, owner, client) = create_ledger();
    let sub = Address::generate(&env);

    let batch_id = client.build_digest(
        &owner,
        &sub,
        &symbol_short!("audit"),
        &DeliveryChannel::Email,
        &DigestPreference::Instant,
        &0u64,
    );

    // Fail it a few times
    client.record_delivery(&owner, &batch_id, &false);
    client.record_delivery(&owner, &batch_id, &false);
    // Clear
    client.clear_bounce(&owner, &batch_id);
    // A subsequent success should work fine
    client.record_delivery(&owner, &batch_id, &true);
    let batch = client.get_digest_batch(&batch_id).unwrap();
    assert!(batch.delivered);
}

// ── Stats aggregation ─────────────────────────────────────────────────────────

#[test]
fn notification_stats_accumulate_across_batches() {
    let (env, owner, client) = create_ledger();
    let sub = Address::generate(&env);

    let b1 = client.build_digest(
        &owner,
        &sub,
        &symbol_short!("x"),
        &DeliveryChannel::Email,
        &DigestPreference::Instant,
        &0u64,
    );
    let b2 = client.build_digest(
        &owner,
        &sub,
        &symbol_short!("y"),
        &DeliveryChannel::Slack,
        &DigestPreference::DailyDigest,
        &0u64,
    );

    client.record_delivery(&owner, &b1, &true);
    client.record_delivery(&owner, &b2, &false);

    let stats = client.get_notification_stats();
    assert_eq!(stats.total_batches, 2);
    assert_eq!(stats.total_delivered, 1);
    assert_eq!(stats.total_failed, 1);
}

// ── Multiple channels ─────────────────────────────────────────────────────────

#[test]
fn multiple_channel_preferences_stored() {
    let (env, _owner, client) = create_ledger();
    let sub = Address::generate(&env);

    let mut channels = Vec::new(&env);
    channels.push_back(ChannelPreference {
        channel: DeliveryChannel::Email,
        digest: DigestPreference::Instant,
        endpoint: Bytes::from_slice(&env, b"user@example.com"),
        active: true,
    });
    channels.push_back(ChannelPreference {
        channel: DeliveryChannel::Discord,
        digest: DigestPreference::DailyDigest,
        endpoint: Bytes::from_slice(&env, b"https://discord.com/webhook/test"),
        active: true,
    });

    client.set_notification_preference(&sub, &symbol_short!("audit"), &channels);

    let pref = client
        .get_notification_preference(&sub, &symbol_short!("audit"))
        .unwrap();
    assert_eq!(pref.channels.len(), 2);
    assert_eq!(pref.channels.get(0).unwrap().channel, DeliveryChannel::Email);
    assert_eq!(pref.channels.get(1).unwrap().channel, DeliveryChannel::Discord);
}

// ── Default fallback ──────────────────────────────────────────────────────────

#[test]
fn preference_update_overwrites_previous() {
    let (env, _owner, client) = create_ledger();
    let sub = Address::generate(&env);

    let mut channels1 = Vec::new(&env);
    channels1.push_back(ChannelPreference {
        channel: DeliveryChannel::Email,
        digest: DigestPreference::Instant,
        endpoint: Bytes::from_slice(&env, b"old@example.com"),
        active: true,
    });
    client.set_notification_preference(&sub, &symbol_short!("ev"), &channels1);

    let mut channels2 = Vec::new(&env);
    channels2.push_back(ChannelPreference {
        channel: DeliveryChannel::Webhook,
        digest: DigestPreference::WeeklyDigest,
        endpoint: Bytes::from_slice(&env, b"https://new-webhook.example.com"),
        active: true,
    });
    client.set_notification_preference(&sub, &symbol_short!("ev"), &channels2);

    let pref = client.get_notification_preference(&sub, &symbol_short!("ev")).unwrap();
    assert_eq!(pref.channels.len(), 1);
    assert_eq!(pref.channels.get(0).unwrap().channel, DeliveryChannel::Webhook);
}
