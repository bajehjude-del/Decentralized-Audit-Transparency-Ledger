#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, Bytes, Env, String, Symbol, Vec};

fn setup_ledger() -> (Env, Address, AuditLedgerClient<'static>) {
    let env = Env::default();
    let owner = Address::generate(&env);
    let contract_id = env.register(AuditLedger, ());
    let client = AuditLedgerClient::new(&env, &contract_id);

    env.mock_all_auths();
    let mut owners = Vec::new(&env);
    owners.push_back(owner.clone());
    client.initialize(&owners, &100, &4096);
    (env, owner, client)
}

#[test]
fn test_default_pause_state_is_unpaused() {
    let (_env, _owner, client) = setup_ledger();

    assert!(!client.is_paused());
    let cfg = client.get_pause_config();
    assert!(!cfg.log_events);
    assert!(!cfg.governance);
    assert!(!cfg.queries);
    assert!(!cfg.is_any_paused());
}

#[test]
fn test_granular_pause_only_log_events() {
    let (env, owner, client) = setup_ledger();

    let pause_cfg = PauseConfig {
        log_events: true,
        governance: false,
        queries: false,
    };
    client.set_pause_config(&owner, &pause_cfg);

    assert!(client.is_paused());
    let retrieved_cfg = client.get_pause_config();
    assert!(retrieved_cfg.log_events);
    assert!(!retrieved_cfg.governance);
    assert!(!retrieved_cfg.queries);

    // Queries should still succeed
    let stats = client.get_statistics(&owner);
    assert_eq!(stats.total_events, 0);

    // Logging events should fail with ContractPaused error
    let submitter = Address::generate(&env);
    let log_res = client.try_log_event(
        &submitter,
        &Symbol::new(&env, "transfer"),
        &Bytes::from_slice(&env, b"payload"),
        &None,
        &None,
        &false,
    );
    assert!(log_res.is_err());
}

#[test]
fn test_granular_pause_only_governance() {
    let (env, owner, client) = setup_ledger();

    let pause_cfg = PauseConfig {
        log_events: false,
        governance: true,
        queries: false,
    };
    client.set_pause_config(&owner, &pause_cfg);

    let retrieved_cfg = client.get_pause_config();
    assert!(!retrieved_cfg.log_events);
    assert!(retrieved_cfg.governance);
    assert!(!retrieved_cfg.queries);

    // Log event succeeds
    let submitter = Address::generate(&env);
    let event_id = client.log_event(
        &submitter,
        &Symbol::new(&env, "transfer"),
        &Bytes::from_slice(&env, b"payload"),
        &None,
        &None,
        &false,
    );
    assert_eq!(event_id.to_array().len(), 32);

    // Governance operation should fail
    let new_owner = Address::generate(&env);
    let gov_res = client.try_add_owner(&owner, &new_owner);
    assert!(gov_res.is_err());
}

#[test]
fn test_pause_with_details_tracks_reason_metadata_and_expiration() {
    let (env, owner, client) = setup_ledger();
    env.ledger().set_timestamp(1000);

    let reason = String::from_str(&env, "Emergency maintenance");
    let metadata = Bytes::from_slice(&env, b"maintenance_ref_99");
    let duration = 300u64; // 5 minutes

    client.pause_with_details(&owner, &reason, &metadata, &duration);

    assert!(client.is_paused());
    let cfg = client.get_pause_config();
    assert!(cfg.log_events);
    assert!(cfg.governance);
    assert!(cfg.queries);

    // Check health status reports pause and metadata
    let health = client.health_check();
    assert!(health.is_paused);
    assert!(health.pause_config.log_events);
    assert!(health.pause_config.governance);
    assert!(health.pause_config.queries);

    // Before expiration: operations paused
    let submitter = Address::generate(&env);
    let res = client.try_log_event(
        &submitter,
        &Symbol::new(&env, "transfer"),
        &Bytes::from_slice(&env, b"payload"),
        &None,
        &None,
        &false,
    );
    assert!(res.is_err());

    // Advance time past expiration (1000 + 300 = 1300)
    env.ledger().set_timestamp(1301);

    // Auto-unpause should unpause operations!
    assert!(!client.is_paused());
    let unpaused_cfg = client.get_pause_config();
    assert!(!unpaused_cfg.log_events);
    assert!(!unpaused_cfg.governance);
    assert!(!unpaused_cfg.queries);

    // Logging event now succeeds
    let event_id = client.log_event(
        &submitter,
        &Symbol::new(&env, "transfer"),
        &Bytes::from_slice(&env, b"payload"),
        &None,
        &None,
        &false,
    );
    assert_eq!(event_id.to_array().len(), 32);
}

#[test]
fn test_unpause_resets_granular_controls() {
    let (_env, owner, client) = setup_ledger();

    client.pause(&owner);
    assert!(client.is_paused());
    assert!(client.get_pause_config().is_any_paused());

    client.unpause(&owner);
    assert!(!client.is_paused());
    assert!(!client.get_pause_config().is_any_paused());
}
