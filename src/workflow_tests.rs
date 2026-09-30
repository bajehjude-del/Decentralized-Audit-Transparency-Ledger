use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{symbol_short, Address, Bytes, BytesN, Env, Symbol, Vec};

use crate::cross_contract::{EventRef, WorkflowStatus, WorkflowStep};

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

fn dummy_event_ref(env: &Env, contract: &Address) -> EventRef {
    EventRef {
        contract: contract.clone(),
        event_id: BytesN::from_array(env, &[1u8; 32]),
        index: 0,
        event_hash: BytesN::from_array(env, &[2u8; 32]),
    }
}

// ── Cross-contract composition ────────────────────────────────────────────────

#[test]
fn log_event_with_refs_creates_composition() {
    let (env, _owner, client) = create_ledger();
    let composer = Address::generate(&env);
    let contract_b = Address::generate(&env);

    let mut refs = Vec::new(&env);
    refs.push_back(dummy_event_ref(&env, &contract_b));

    let comp_id = client.log_event_with_refs(
        &composer,
        &symbol_short!("settled"),
        &refs,
        &Bytes::from_slice(&env, b"metadata"),
    );

    assert_eq!(comp_id, 0);
    let evts = client.get_cross_contract_events(&0u32, &10u32);
    assert_eq!(evts.len(), 1);
    assert_eq!(evts.get(0).unwrap().name, symbol_short!("settled"));
    assert_eq!(evts.get(0).unwrap().refs.len(), 1);
}

#[test]
fn multiple_compositions_increment_ids() {
    let (env, _owner, client) = create_ledger();
    let composer = Address::generate(&env);
    let contract_b = Address::generate(&env);

    let mut refs = Vec::new(&env);
    refs.push_back(dummy_event_ref(&env, &contract_b));

    let id1 = client.log_event_with_refs(&composer, &symbol_short!("c1"), &refs, &Bytes::new(&env));
    let id2 = client.log_event_with_refs(&composer, &symbol_short!("c2"), &refs, &Bytes::new(&env));

    assert_eq!(id1, 0);
    assert_eq!(id2, 1);
}

#[test]
fn validate_cross_contract_refs_valid() {
    let (env, _owner, client) = create_ledger();
    let contract_b = Address::generate(&env);

    let mut refs = Vec::new(&env);
    refs.push_back(dummy_event_ref(&env, &contract_b));

    assert!(client.validate_cross_contract_refs(&refs));
}

#[test]
fn validate_cross_contract_refs_zero_id_fails() {
    let (env, _owner, client) = create_ledger();
    let contract_b = Address::generate(&env);

    let mut refs = Vec::new(&env);
    refs.push_back(EventRef {
        contract: contract_b,
        event_id: BytesN::from_array(&env, &[0u8; 32]),
        index: 0,
        event_hash: BytesN::from_array(&env, &[0u8; 32]),
    });

    assert!(!client.validate_cross_contract_refs(&refs));
}

// ── External event anchoring ──────────────────────────────────────────────────

#[test]
fn register_external_event_stores_anchor() {
    let (env, _owner, client) = create_ledger();
    let submitter = Address::generate(&env);

    let ext_id = client.register_external_event(
        &submitter,
        &symbol_short!("ethereum"),
        &Bytes::from_slice(&env, b"0xabc123"),
        &BytesN::from_array(&env, &[9u8; 32]),
        &Bytes::from_slice(&env, b"eth tx"),
    );

    assert_eq!(ext_id, 0);
}

// ── Workflow definition ───────────────────────────────────────────────────────

#[test]
fn define_workflow_creates_definition() {
    let (env, owner, client) = create_ledger();

    let mut steps = Vec::new(&env);
    steps.push_back(WorkflowStep {
        index: 0,
        name: symbol_short!("approve"),
        expected_event_type: symbol_short!("approval"),
        optional: false,
        min_delay_secs: 0,
        max_delay_secs: 0,
    });
    steps.push_back(WorkflowStep {
        index: 1,
        name: symbol_short!("ship"),
        expected_event_type: symbol_short!("shipment"),
        optional: false,
        min_delay_secs: 0,
        max_delay_secs: 0,
    });

    let wf_id = client.define_workflow(&owner, &symbol_short!("trade"), &steps);

    let wfs = client.list_workflows(&0u32, &10u32);
    assert_eq!(wfs.len(), 1);
    assert_eq!(wfs.get(0).unwrap().id, wf_id);
    assert_eq!(wfs.get(0).unwrap().steps.len(), 2);
}

#[test]
fn list_workflows_pagination() {
    let (env, owner, client) = create_ledger();

    for i in 0..5u32 {
        let mut steps = Vec::new(&env);
        steps.push_back(WorkflowStep {
            index: 0,
            name: symbol_short!("step"),
            expected_event_type: symbol_short!("ev"),
            optional: false,
            min_delay_secs: 0,
            max_delay_secs: 0,
        });
        client.define_workflow(&owner, &symbol_short!("wf"), &steps);
    }

    let page1 = client.list_workflows(&0u32, &3u32);
    let page2 = client.list_workflows(&3u32, &3u32);
    assert_eq!(page1.len(), 3);
    assert_eq!(page2.len(), 2);
}

// ── Workflow execution ────────────────────────────────────────────────────────

#[test]
fn start_workflow_creates_execution() {
    let (env, owner, client) = create_ledger();
    let initiator = Address::generate(&env);

    let mut steps = Vec::new(&env);
    steps.push_back(WorkflowStep {
        index: 0,
        name: symbol_short!("pay"),
        expected_event_type: symbol_short!("payment"),
        optional: false,
        min_delay_secs: 0,
        max_delay_secs: 0,
    });

    let wf_id = client.define_workflow(&owner, &symbol_short!("trade"), &steps);
    let exec_id = client.start_workflow(&initiator, &wf_id, &Bytes::new(&env));

    let exec = client.get_workflow_events(&exec_id).unwrap();
    assert_eq!(exec.definition_id, wf_id);
    assert_eq!(exec.status, WorkflowStatus::InProgress);
}

#[test]
fn record_workflow_step_stores_event_ref() {
    let (env, owner, client) = create_ledger();
    let initiator = Address::generate(&env);
    let contract_b = Address::generate(&env);

    let mut steps = Vec::new(&env);
    steps.push_back(WorkflowStep {
        index: 0,
        name: symbol_short!("approve"),
        expected_event_type: symbol_short!("approval"),
        optional: false,
        min_delay_secs: 0,
        max_delay_secs: 0,
    });
    steps.push_back(WorkflowStep {
        index: 1,
        name: symbol_short!("ship"),
        expected_event_type: symbol_short!("shipment"),
        optional: false,
        min_delay_secs: 0,
        max_delay_secs: 0,
    });

    let wf_id = client.define_workflow(&owner, &symbol_short!("trade"), &steps);
    let exec_id = client.start_workflow(&initiator, &wf_id, &Bytes::new(&env));

    client.record_workflow_step(&initiator, &exec_id, &0u32, &dummy_event_ref(&env, &contract_b));
    client.record_workflow_step(&initiator, &exec_id, &1u32, &dummy_event_ref(&env, &contract_b));

    assert!(client.verify_cross_chain_workflow(&exec_id));
}

#[test]
fn workflow_incomplete_fails_verification() {
    let (env, owner, client) = create_ledger();
    let initiator = Address::generate(&env);
    let contract_b = Address::generate(&env);

    let mut steps = Vec::new(&env);
    steps.push_back(WorkflowStep {
        index: 0,
        name: symbol_short!("approve"),
        expected_event_type: symbol_short!("approval"),
        optional: false,
        min_delay_secs: 0,
        max_delay_secs: 0,
    });
    steps.push_back(WorkflowStep {
        index: 1,
        name: symbol_short!("ship"),
        expected_event_type: symbol_short!("shipment"),
        optional: false,
        min_delay_secs: 0,
        max_delay_secs: 0,
    });

    let wf_id = client.define_workflow(&owner, &symbol_short!("trade"), &steps);
    let exec_id = client.start_workflow(&initiator, &wf_id, &Bytes::new(&env));

    // Only record step 0
    client.record_workflow_step(&initiator, &exec_id, &0u32, &dummy_event_ref(&env, &contract_b));

    assert!(!client.verify_cross_chain_workflow(&exec_id));
}

#[test]
fn optional_step_not_required_for_verification() {
    let (env, owner, client) = create_ledger();
    let initiator = Address::generate(&env);
    let contract_b = Address::generate(&env);

    let mut steps = Vec::new(&env);
    steps.push_back(WorkflowStep {
        index: 0,
        name: symbol_short!("required"),
        expected_event_type: symbol_short!("payment"),
        optional: false,
        min_delay_secs: 0,
        max_delay_secs: 0,
    });
    steps.push_back(WorkflowStep {
        index: 1,
        name: symbol_short!("optional"),
        expected_event_type: symbol_short!("notif"),
        optional: true, // this step can be skipped
        min_delay_secs: 0,
        max_delay_secs: 0,
    });

    let wf_id = client.define_workflow(&owner, &symbol_short!("simple"), &steps);
    let exec_id = client.start_workflow(&initiator, &wf_id, &Bytes::new(&env));

    // Only record the mandatory step
    client.record_workflow_step(&initiator, &exec_id, &0u32, &dummy_event_ref(&env, &contract_b));

    assert!(client.verify_cross_chain_workflow(&exec_id));
}

#[test]
fn complete_workflow_changes_status() {
    let (env, owner, client) = create_ledger();
    env.ledger().set_timestamp(1_700_000_000);
    let initiator = Address::generate(&env);

    let mut steps = Vec::new(&env);
    steps.push_back(WorkflowStep {
        index: 0,
        name: symbol_short!("pay"),
        expected_event_type: symbol_short!("payment"),
        optional: false,
        min_delay_secs: 0,
        max_delay_secs: 0,
    });

    let wf_id = client.define_workflow(&owner, &symbol_short!("trade"), &steps);
    let exec_id = client.start_workflow(&initiator, &wf_id, &Bytes::new(&env));

    client.complete_workflow(&owner, &exec_id);

    let exec = client.get_workflow_events(&exec_id).unwrap();
    assert_eq!(exec.status, WorkflowStatus::Completed);
    assert!(exec.finished_at > 0);
}

// ── Cross-contract compositions paginated listing ─────────────────────────────

#[test]
fn get_cross_contract_events_pagination() {
    let (env, _owner, client) = create_ledger();
    let composer = Address::generate(&env);
    let contract_b = Address::generate(&env);
    let mut refs = Vec::new(&env);
    refs.push_back(dummy_event_ref(&env, &contract_b));

    for _ in 0..5u32 {
        client.log_event_with_refs(&composer, &symbol_short!("ev"), &refs, &Bytes::new(&env));
    }

    let p1 = client.get_cross_contract_events(&0u32, &3u32);
    let p2 = client.get_cross_contract_events(&3u32, &3u32);
    assert_eq!(p1.len(), 3);
    assert_eq!(p2.len(), 2);
}
