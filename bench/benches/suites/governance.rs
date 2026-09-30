//! Scenario group: governance and configuration writes.
//!
//! Every contract entry point that mutates configuration lives here. These calls
//! are owner-authorised, so their cost is dominated by authorization, the
//! `RuntimeState`/config write amplification, and the emitted governance event.
//! The goal is to make every administrative write visible in the report, because
//! each one adds a `write_entries` cost that operators pay per transaction.

use audit_ledger::{ArchiveConfig, ProposalAction, Role};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Bytes, BytesN, Symbol, Vec};

use crate::support::fixture::Fixture;
use crate::support::measure::{measure_call, Bench, CaseSpec};

pub fn run(bench: &mut Bench) {
    lifecycle(bench);
    capacity_and_limits(bench);
    access_control(bench);
    dedup_and_nonce(bench);
    schemas_and_migrations(bench);
    indexing_and_emission(bench);
    proposals(bench);
    archival_governance(bench);
    advanced_write_entrypoints(bench);
    configuration_reads(bench);
}

/// Pause / unpause and the remaining single-flag state toggles.
fn lifecycle(bench: &mut Bench) {
    measure_call(
        bench,
        CaseSpec::new("governance", "pause", "pause").notes("emergency stop of all writes"),
        owner_arg(),
        |fixture, owner| {
            fixture.client.pause(owner);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "unpause", "unpause").notes("resume after a pause; fixture is paused first"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            fixture.client.pause(&owner);
            (fixture, owner)
        },
        |fixture, owner| {
            fixture.client.unpause(owner);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "is_paused", "is_paused"),
        owner_arg(),
        |fixture, _| fixture.client.is_paused() as u64,
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "paused_since", "paused_since"),
        owner_arg(),
        |fixture, _| fixture.client.paused_since(),
    );
}

/// Capacity, TTL and metadata limit configuration.
fn capacity_and_limits(bench: &mut Bench) {
    measure_call(
        bench,
        CaseSpec::new("governance", "set_global_max_logs", "set_global_max_logs")
            .notes("also rewrites the cached RuntimeState"),
        owner_arg(),
        |fixture, owner| {
            fixture.client.set_global_max_logs(owner, &250_000);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "set_event_max_logs", "set_event_max_logs")
            .notes("per-type cap; adds a new cap entry"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            let event_type = Symbol::new(&fixture.env, "transfer");
            (fixture, (owner, event_type))
        },
        |fixture, args| {
            let (owner, event_type) = args;
            fixture.client.set_event_max_logs(owner, event_type, &5_000);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "remove_event_cap", "remove_event_cap"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            let event_type = Symbol::new(&fixture.env, "transfer");
            fixture.client.set_event_max_logs(&owner, &event_type, &5_000);
            (fixture, (owner, event_type))
        },
        |fixture, args| {
            let (owner, event_type) = args;
            fixture.client.remove_event_cap(owner, event_type);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "has_cap", "has_cap"),
        owner_arg(),
        |fixture, _| fixture.client.has_cap(&Symbol::new(&fixture.env, "transfer")) as u64,
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "set_metadata_max_size", "set_metadata_max_size")
            .notes("global metadata ceiling (1 KiB -> 8 KiB)"),
        owner_arg(),
        |fixture, owner| {
            fixture.client.set_metadata_max_size(owner, &8_192);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new(
            "governance",
            "set_event_metadata_max_size",
            "set_event_metadata_max_size",
        ),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            let event_type = Symbol::new(&fixture.env, "transfer");
            (fixture, (owner, event_type))
        },
        |fixture, args| {
            let (owner, event_type) = args;
            fixture.client.set_event_metadata_max_size(owner, event_type, &2_048);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "set_category_max_len", "set_category_max_len"),
        owner_arg(),
        |fixture, owner| {
            fixture.client.set_category_max_len(owner, &64);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "set_event_ttl", "set_event_ttl")
            .notes("turns on persistent storage for every event"),
        owner_arg(),
        |fixture, owner| {
            fixture.client.set_event_ttl(owner, &5_184);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "set_low_cost_mode", "set_low_cost_mode")
            .notes("skips the per-type and per-submitter index maintenance"),
        owner_arg(),
        |fixture, owner| {
            fixture.client.set_low_cost_mode(owner, &true);
            1
        },
    );

    for mode in [0u32, 1, 2] {
        measure_call(
            bench,
            CaseSpec::new(
                "governance",
                &format!("set_event_emission_mode_{mode}"),
                "set_event_emission_mode",
            )
            .notes("emission mode 0 = off, 1 = minimal, 2 = full"),
            owner_arg(),
            |fixture, owner| {
                fixture.client.set_event_emission_mode(owner, &mode);
                1
            },
        );
    }
}

/// Owner set, multi-sig threshold, RBAC and the submitter allow/deny lists.
fn access_control(bench: &mut Bench) {
    measure_call(
        bench,
        CaseSpec::new("governance", "add_owner", "add_owner"),
        owner_arg(),
        |fixture, owner| {
            let new_owner = Address::generate(&fixture.env);
            fixture.client.add_owner(owner, &new_owner);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "remove_owner", "remove_owner").notes("removing the last owner is rejected"),
        || {
            let (fixture, extra) = Fixture::with_extra_owners(1);
            (fixture, extra)
        },
        |fixture, extra| {
            let owner = fixture.owner.clone();
            let removed = extra.get(0).unwrap();
            fixture.client.remove_owner(&owner, &removed);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "set_required_signatures", "set_required_signatures")
            .notes("multi-sig threshold 1 -> 3"),
        owner_arg(),
        |fixture, owner| {
            fixture.client.set_required_signatures(owner, &3);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "transfer_ownership", "transfer_ownership"),
        owner_arg(),
        |fixture, owner| {
            let new_owner = Address::generate(&fixture.env);
            fixture.client.transfer_ownership(owner, &new_owner);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "set_role_grant", "set_role").notes("grant Auditor"),
        owner_arg(),
        |fixture, owner| {
            let target = Address::generate(&fixture.env);
            fixture.client.set_role(owner, &target, &Some(Role::Auditor));
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "set_role_revoke", "set_role").notes("revoke a role"),
        owner_arg(),
        |fixture, owner| {
            let target = Address::generate(&fixture.env);
            fixture.client.set_role(owner, &target, &None);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "get_role", "get_role"),
        owner_arg(),
        |fixture, _| {
            let owner = fixture.owner.clone();
            fixture.client.get_role(&owner).is_some() as u64
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "enable_rbac", "enable_rbac"),
        owner_arg(),
        |fixture, owner| {
            fixture.client.enable_rbac(owner, &true);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "is_rbac_enabled", "is_rbac_enabled"),
        owner_arg(),
        |fixture, _| fixture.client.is_rbac_enabled() as u64,
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "enable_allowlist_mode", "enable_allowlist_mode"),
        owner_arg(),
        |fixture, owner| {
            fixture.client.enable_allowlist_mode(owner);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "disable_allowlist_mode", "disable_allowlist_mode")
            .notes("allowlist mode is enabled first"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            fixture.client.enable_allowlist_mode(&owner);
            (fixture, owner)
        },
        |fixture, owner| {
            fixture.client.disable_allowlist_mode(owner);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "allow_submitter", "allow_submitter"),
        owner_arg(),
        |fixture, owner| {
            let submitter = fixture.submitter.clone();
            fixture.client.allow_submitter(owner, &submitter);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "block_submitter", "block_submitter"),
        owner_arg(),
        |fixture, owner| {
            let submitter = fixture.submitter.clone();
            fixture.client.block_submitter(owner, &submitter);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new(
            "governance",
            "remove_submitter_from_allowlist",
            "remove_submitter_from_allowlist",
        )
        .notes("submitter is on the allowlist first"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            let submitter = fixture.submitter.clone();
            fixture.client.allow_submitter(&owner, &submitter);
            (fixture, owner)
        },
        |fixture, owner| {
            let submitter = fixture.submitter.clone();
            fixture.client.remove_submitter_from_allowlist(owner, &submitter);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "set_submitter_rate_limit", "set_submitter_rate_limit"),
        owner_arg(),
        |fixture, owner| {
            let submitter = fixture.submitter.clone();
            fixture.client.set_submitter_rate_limit(owner, &submitter, &100);
            1
        },
    );
}

/// Deduplication policy matrix and nonce replay protection.
fn dedup_and_nonce(bench: &mut Bench) {
    for (index, policy) in [
        audit_ledger::DedupPolicy::None,
        audit_ledger::DedupPolicy::ContentHash,
        audit_ledger::DedupPolicy::ContentHashWithTimestamp,
        audit_ledger::DedupPolicy::Custom,
    ]
    .iter()
    .enumerate()
    {
        let names = ["none", "content_hash", "content_hash_with_timestamp", "custom"];
        let policy = *policy;
        measure_call(
            bench,
            CaseSpec::new(
                "governance",
                &format!("set_dedup_policy_{}", names[index]),
                "set_dedup_policy",
            )
            .notes("switches the global dedup strategy"),
            owner_arg(),
            |fixture, owner| {
                fixture.client.set_dedup_policy(owner, &policy);
                1
            },
        );
    }

    measure_call(
        bench,
        CaseSpec::new("governance", "set_dedup_policy_for_type", "set_dedup_policy_for_type")
            .notes("per-type override"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            let event_type = Symbol::new(&fixture.env, "transfer");
            (fixture, (owner, event_type))
        },
        |fixture, args| {
            let (owner, event_type) = args;
            fixture
                .client
                .set_dedup_policy_for_type(owner, event_type, &Some(audit_ledger::DedupPolicy::Custom));
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "get_dedup_policy_for_type", "get_dedup_policy_for_type"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            let event_type = Symbol::new(&fixture.env, "transfer");
            (fixture, (owner, event_type))
        },
        |fixture, args| {
            let (_, event_type) = args;
            match fixture.client.get_dedup_policy_for_type(event_type) {
                audit_ledger::DedupPolicy::None => 0,
                audit_ledger::DedupPolicy::ContentHash => 1,
                audit_ledger::DedupPolicy::ContentHashWithTimestamp => 2,
                audit_ledger::DedupPolicy::Custom => 3,
            }
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "set_submitter_nonce_config", "set_submitter_nonce_config"),
        owner_arg(),
        |fixture, owner| {
            let submitter = fixture.submitter.clone();
            fixture
                .client
                .set_submitter_nonce_config(owner, &submitter, &500, &10_000);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "set_default_nonce_config", "set_default_nonce_config"),
        owner_arg(),
        |fixture, owner| {
            fixture.client.set_default_nonce_config(owner, &250, &5_000);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "reset_submitter_nonce", "reset_submitter_nonce")
            .notes("the submitter has consumed a nonce first"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            let submitter = fixture.submitter.clone();
            let event_type = Symbol::new(&fixture.env, "transfer");
            fixture
                .client
                .log_event_with_nonce(&submitter, &event_type, &fixture.metadata(32, 7), &42);
            (fixture, (owner, submitter))
        },
        |fixture, args| {
            let (owner, submitter) = args;
            fixture.client.reset_submitter_nonce(owner, submitter);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "get_submitter_nonce", "get_submitter_nonce"),
        owner_arg(),
        |fixture, _| {
            let submitter = fixture.submitter.clone();
            fixture.client.get_submitter_nonce(&submitter) as u64
        },
    );
}

/// Schema registration, compatibility checks and metadata migration.
fn schemas_and_migrations(bench: &mut Bench) {
    measure_call(
        bench,
        CaseSpec::new("governance", "register_schema", "register_schema")
            .notes("validates and stores a JSON schema definition"),
        owner_arg(),
        |fixture, owner| {
            let event_type = Symbol::new(&fixture.env, "transfer");
            let schema = audit_ledger::Schema {
                format: audit_ledger::SchemaFormat::JsonSchemaDraft7,
                version: 1,
                definition: Bytes::from_slice(
                    &fixture.env,
                    br#"{"type":"object","properties":{"amount":{"type":"integer"}}}"#,
                ),
                compatibility: audit_ledger::SchemaCompatibility::Backward,
            };
            fixture.client.register_schema(owner, &event_type, &schema, &1u32);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "set_metadata_schema", "set_metadata_schema").notes("legacy single-schema setter"),
        owner_arg(),
        |fixture, owner| {
            let event_type = Symbol::new(&fixture.env, "transfer");
            let schema = Bytes::from_slice(&fixture.env, b"{\"type\":\"object\"}");
            fixture.client.set_metadata_schema(owner, &event_type, &schema);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "check_schema_compatibility", "check_schema_compatibility")
            .notes("pure read, no storage access"),
        || (Fixture::new(), ()),
        |fixture, _| {
            let schema = audit_ledger::Schema {
                format: audit_ledger::SchemaFormat::JsonSchemaDraft7,
                version: 1,
                definition: Bytes::from_slice(&fixture.env, b"{\"type\":\"object\"}"),
                compatibility: audit_ledger::SchemaCompatibility::Backward,
            };
            match fixture.client.check_schema_compatibility(&schema, &schema) {
                audit_ledger::SchemaCompatibility::Full => 0,
                audit_ledger::SchemaCompatibility::Backward => 1,
                audit_ledger::SchemaCompatibility::Forward => 2,
                audit_ledger::SchemaCompatibility::Breaking => 3,
                audit_ledger::SchemaCompatibility::Unknown => 4,
            }
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "is_backward_compatible", "is_backward_compatible"),
        || (Fixture::new(), ()),
        |fixture, _| {
            let schema = audit_ledger::Schema {
                format: audit_ledger::SchemaFormat::JsonSchemaDraft7,
                version: 1,
                definition: Bytes::from_slice(&fixture.env, b"{\"type\":\"object\"}"),
                compatibility: audit_ledger::SchemaCompatibility::Backward,
            };
            fixture.client.is_backward_compatible(&schema, &schema) as u64
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "migrate_event_metadata", "migrate_event_metadata")
            .notes("registers a 1 -> 2 migration function for an event type"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            let event_type = Symbol::new(&fixture.env, "transfer");
            fixture.seed_events(10, 64, "transfer");
            let migration = audit_ledger::MigrationFunction {
                from_version: 1,
                to_version: 2,
                name: Symbol::new(&fixture.env, "add_field"),
                body: Bytes::from_slice(&fixture.env, b"{}"),
            };
            (fixture, (owner, event_type, migration))
        },
        |fixture, args| {
            let (owner, event_type, migration) = args;
            fixture
                .client
                .migrate_event_metadata(owner, event_type, &1, &2, migration);
            1
        },
    );
}

/// Index-heavy administrative operations.
fn indexing_and_emission(bench: &mut Bench) {
    measure_call(
        bench,
        CaseSpec::new("governance", "compact_storage", "compact_storage")
            .notes("drops the type index of an uncapped event type"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            let event_type = Symbol::new(&fixture.env, "transfer");
            fixture.client.set_event_max_logs(&owner, &event_type, &1_000);
            fixture.seed_events(5, 64, "transfer");
            fixture.client.remove_event_cap(&owner, &event_type);
            (fixture, (owner, event_type))
        },
        |fixture, args| {
            let (owner, event_type) = args;
            let mut stale = Vec::new(&fixture.env);
            stale.push_back(event_type.clone());
            fixture.client.compact_storage(owner, &stale) as u64
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "create_snapshot", "create_snapshot")
            .notes("re-walks the hash chain up to the current head"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            fixture.seed_events(50, 64, "transfer");
            (fixture, owner)
        },
        |fixture, owner| {
            let description = Bytes::from_slice(&fixture.env, b"snapshot from benchmark");
            fixture.client.create_snapshot(owner, &description) as u64
        },
    );
}

/// Owner proposal lifecycle: submit, approve, execute.
fn proposals(bench: &mut Bench) {
    measure_call(
        bench,
        CaseSpec::new("governance", "submit_proposal", "submit_proposal").notes("creates the proposal entry"),
        owner_arg(),
        |fixture, owner| {
            let action = ProposalAction::SetGlobalMaxLogs(500_000);
            fixture.client.submit_proposal(owner, &action, &3_600) as u64
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "approve_proposal", "approve_proposal")
            .notes("appends the approval; proposal already submitted"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            let action = ProposalAction::SetGlobalMaxLogs(500_000);
            let id = fixture.client.submit_proposal(&owner, &action, &3_600);
            (fixture, (owner, id))
        },
        |fixture, args| {
            let (owner, id) = args;
            fixture.client.approve_proposal(owner, id);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "execute_proposal", "execute_proposal")
            .notes("applies the action after the required approvals"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            let action = ProposalAction::SetGlobalMaxLogs(500_000);
            let id = fixture.client.submit_proposal(&owner, &action, &3_600);
            fixture.client.approve_proposal(&owner, &id);
            (fixture, (owner, id))
        },
        |fixture, args| {
            let (owner, id) = args;
            fixture.client.execute_proposal(owner, id);
            1
        },
    );
}

/// Archive configuration and the upgrade hook.
fn archival_governance(bench: &mut Bench) {
    measure_call(
        bench,
        CaseSpec::new("governance", "set_archive_config", "set_archive_config")
            .notes("off-chain references + RLE compression"),
        owner_arg(),
        |fixture, owner| {
            let config = ArchiveConfig {
                offchain_storage: true,
                base_url: Bytes::from_slice(&fixture.env, b"https://cdn.example.com/audit/"),
                compression: 1,
            };
            fixture.client.set_archive_config(owner, &config);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "get_archive_config", "get_archive_config"),
        || (Fixture::new(), ()),
        |fixture, _| {
            let _ = fixture.client.get_archive_config();
            1
        },
    );

    // `upgrade_contract` is intentionally absent: the measure harness runs on a
    // plain test `Env`, whose deployer store enforces a 64 KiB-per-entry cap.
    // Uploading the ~360 KiB release WASM (or any plausible upgrade image) trips
    // `Error(Budget, ExceededLimit)`, so the code-swap path cannot be measured
    // here; it needs a full (guarded) host / network run.

    measure_call(
        bench,
        CaseSpec::new("governance", "register_webhook", "register_webhook"),
        owner_arg(),
        |fixture, owner| {
            let event_type = Symbol::new(&fixture.env, "transfer");
            let url = Bytes::from_slice(&fixture.env, b"https://hooks.example.com/audit");
            let secret = Bytes::from_slice(&fixture.env, b"signing-secret");
            fixture.client.register_webhook(owner, &event_type, &url, &secret);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "unregister_webhook", "unregister_webhook").notes("webhook is registered first"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            let event_type = Symbol::new(&fixture.env, "transfer");
            let url = Bytes::from_slice(&fixture.env, b"https://hooks.example.com/audit");
            let secret = Bytes::from_slice(&fixture.env, b"signing-secret");
            fixture.client.register_webhook(&owner, &event_type, &url, &secret);
            (fixture, (owner, event_type, url))
        },
        |fixture, args| {
            let (owner, event_type, url) = args;
            fixture.client.unregister_webhook(owner, event_type, url);
            1
        },
    );
}

/// Write entry points that carry non-trivial argument vectors: signatures,
/// hierarchical events, custom keys, rollbacks and version tags.
fn advanced_write_entrypoints(bench: &mut Bench) {
    measure_call(
        bench,
        CaseSpec::new("governance", "log_event_with_hierarchy", "log_event_with_hierarchy")
            .metadata(64)
            .notes("category + sub-event-type indexing"),
        submitter_arg(),
        |fixture, submitter| {
            let event_type = Symbol::new(&fixture.env, "transfer");
            let category = Symbol::new(&fixture.env, "finance");
            let sub_event_type = Symbol::new(&fixture.env, "settlement");
            let metadata = fixture.metadata(64, 3);
            fixture.client.log_event_with_hierarchy(
                submitter,
                &event_type,
                &metadata,
                &Some(category),
                &Some(sub_event_type),
                &false,
            );
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "log_event_with_nonce", "log_event_with_nonce")
            .metadata(64)
            .notes("replay-protected write with an explicit nonce"),
        submitter_arg(),
        |fixture, submitter| {
            let event_type = Symbol::new(&fixture.env, "transfer");
            let metadata = fixture.metadata(64, 4);
            fixture
                .client
                .log_event_with_nonce(submitter, &event_type, &metadata, &1u32);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "log_event_signed", "log_event_signed")
            .metadata(64)
            .notes("adds a detached signature over the payload"),
        submitter_arg(),
        |fixture, submitter| {
            let event_type = Symbol::new(&fixture.env, "transfer");
            let metadata = fixture.metadata(64, 5);
            let signature_payload = Bytes::from_slice(&fixture.env, &[0x5A; 96]);
            fixture
                .client
                .log_event_signed(submitter, &event_type, &metadata, &signature_payload);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "get_event_signature", "get_event_signature")
            .notes("signature lookup for a signed event"),
        || {
            let fixture = Fixture::new();
            let submitter = fixture.submitter.clone();
            let event_type = Symbol::new(&fixture.env, "transfer");
            let metadata = fixture.metadata(64, 5);
            let signature_payload = Bytes::from_slice(&fixture.env, &[0x5A; 96]);
            let id = fixture
                .client
                .log_event_signed(&submitter, &event_type, &metadata, &signature_payload);
            (fixture, id)
        },
        |fixture, id| {
            let _ = fixture.client.get_event_signature(id);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "log_event_with_custom_key", "log_event_with_custom_key")
            .metadata(64)
            .notes("caller-supplied dedup key"),
        submitter_arg(),
        |fixture, submitter| {
            let event_type = Symbol::new(&fixture.env, "transfer");
            let metadata = fixture.metadata(64, 6);
            let custom_key = BytesN::from_array(&fixture.env, &[0x11; 32]);
            fixture.client.log_event_with_custom_key(
                submitter,
                &event_type,
                &metadata,
                &None,
                &None,
                &false,
                &Some(custom_key),
            );
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "rollback_event", "rollback_event")
            .notes("two versions exist; rolls back to version 0"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            fixture.seed_events(10, 64, "transfer");
            fixture.client.update_event(&owner, &5, &fixture.metadata(64, 900));
            (fixture, owner)
        },
        |fixture, owner| {
            fixture.client.rollback_event(owner, &5, &0);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "tag_event_version", "tag_event_version"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            fixture.seed_events(10, 64, "transfer");
            fixture.client.update_event(&owner, &5, &fixture.metadata(64, 900));
            (fixture, owner)
        },
        |fixture, owner| {
            let tag = Symbol::new(&fixture.env, "disputed");
            fixture.client.tag_event_version(owner, &5, &1, &tag);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "update_event", "update_event")
            .metadata(64)
            .notes("supersedes an event: new hash plus version append"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            fixture.seed_events(10, 64, "transfer");
            (fixture, owner)
        },
        |fixture, owner| {
            fixture.client.update_event(owner, &5, &fixture.metadata(64, 900));
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new(
            "governance",
            "compare_event_versions_detailed",
            "compare_event_versions_detailed",
        )
        .notes("field-level diff over a two-version event"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            fixture.seed_events(10, 64, "transfer");
            fixture.client.update_event(&owner, &5, &fixture.metadata(64, 900));
            (fixture, ())
        },
        |fixture, _| {
            let _ = fixture.client.compare_event_versions_detailed(&5u32, &0u32, &1u32);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "get_statistics", "get_statistics")
            .notes("aggregates per-type and per-submitter counters"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            fixture.seed_event_types(&["transfer", "approval", "audit"], 10, 64);
            (fixture, owner)
        },
        |fixture, owner| {
            let _ = fixture.client.get_statistics(owner);
            1
        },
    );
}

/// Cheap configuration reads kept in the governance suite because they describe
/// administrative state rather than event data.
fn configuration_reads(bench: &mut Bench) {
    measure_call(
        bench,
        CaseSpec::new("governance", "get_event_emission_mode", "get_event_emission_mode"),
        || (Fixture::new(), ()),
        |fixture, _| fixture.client.get_event_emission_mode() as u64,
    );

    measure_call(
        bench,
        CaseSpec::new("governance", "snapshot_count", "snapshot_count"),
        || (Fixture::new(), ()),
        |fixture, _| fixture.client.snapshot_count() as u64,
    );

    measure_call(
        bench,
        CaseSpec::new(
            "governance",
            "get_default_nonce_window_size",
            "get_default_nonce_window_size",
        ),
        || (Fixture::new(), ()),
        |fixture, _| fixture.client.get_default_nonce_window_size() as u64,
    );

    measure_call(
        bench,
        CaseSpec::new(
            "governance",
            "get_default_nonce_max_value",
            "get_default_nonce_max_value",
        )
        .notes("returns u32::MAX, the sentinel for 'unlimited'"),
        || (Fixture::new(), ()),
        |fixture, _| fixture.client.get_default_nonce_max_value() as u64,
    );
}

/// Setup helper: a fresh fixture plus its submitter address.
fn submitter_arg() -> impl FnMut() -> (Fixture, Address) {
    || {
        let fixture = Fixture::new();
        let submitter = fixture.submitter.clone();
        (fixture, submitter)
    }
}

/// Setup helper: a fresh fixture plus its owner address.
fn owner_arg() -> impl FnMut() -> (Fixture, Address) {
    || {
        let fixture = Fixture::new();
        let owner = fixture.owner.clone();
        (fixture, owner)
    }
}
