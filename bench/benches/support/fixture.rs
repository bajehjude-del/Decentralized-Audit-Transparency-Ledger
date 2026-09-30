//! Benchmark fixtures for the AuditLedger contract suite.
//!
//! Every case gets a freshly built `Env` so that measurements are not polluted
//! by state left behind by a previous case. Fixture construction is *never*
//! part of a measurement — see [`crate::support::measure`].

use audit_ledger::AuditLedger;
use audit_ledger::AuditLedgerClient;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, Bytes, BytesN, Env, Symbol, Vec};

/// `global_max_logs` used by fixtures unless a case needs a different cap.
pub const DEFAULT_MAX_EVENTS: u32 = 100_000;
/// `max_metadata_bytes` used by fixtures (4 KiB).
///
/// `initialize` takes the cap as an argument, so this is the *configured* limit
/// for every fixture — not the contract's own `DEFAULT_MAX_METADATA_SIZE` of
/// 1 KiB, which only applies when a deployment passes zero. Cases that probe
/// the ceiling must measure against this value, not the 1 KiB default.
pub const DEFAULT_METADATA_LIMIT: u32 = 4096;
/// Ledger timestamp used for every fixture so that seeded events stay inside
/// the contract's monotonic-timestamp window (issue #76).
pub const BASE_TIMESTAMP: u64 = 1_700_000_000;

/// A deployed contract plus the identities used to drive it.
pub struct Fixture {
    pub env: Env,
    pub owner: Address,
    pub submitter: Address,
    pub client: AuditLedgerClient<'static>,
}

impl Fixture {
    /// Deploy a fresh contract with default caps and mocked authorizations.
    pub fn new() -> Self {
        Self::with_caps(DEFAULT_MAX_EVENTS, DEFAULT_METADATA_LIMIT)
    }

    /// Register the contract *without* calling `initialize`, so that the
    /// deployment cost itself can be measured as a case.
    pub fn uninitialized() -> Self {
        let env = test_env();
        let owner = Address::generate(&env);
        let submitter = Address::generate(&env);
        let contract_id = env.register(AuditLedger, ());
        let client = AuditLedgerClient::new(&env, &contract_id);
        env.mock_all_auths();
        env.ledger().set_timestamp(BASE_TIMESTAMP);
        Self {
            env,
            owner,
            submitter,
            client,
        }
    }

    /// Deploy a fresh contract with explicit capacity/limits.
    pub fn with_caps(global_max_logs: u32, max_metadata_bytes: u32) -> Self {
        let fixture = Self::uninitialized();
        let mut owners = Vec::new(&fixture.env);
        owners.push_back(fixture.owner.clone());
        fixture
            .client
            .initialize(&owners, &global_max_logs, &max_metadata_bytes);
        fixture
    }

    /// Disable the per-invocation mainnet resource limits.
    ///
    /// Scenarios that intentionally model a batch larger than a single
    /// transaction may carry (for example 25+ events) need this; the measured
    /// resource numbers stay identical, the enforcement simply stops panicking.
    pub fn without_resource_limits(&self) -> &Self {
        self.env.cost_estimate().disable_resource_limits();
        self
    }

    /// Add `count` owners to the deployed contract (multi-sig governance).
    pub fn with_extra_owners(count: u32) -> (Self, Vec<Address>) {
        let fixture = Self::new();
        let mut extra = Vec::new(&fixture.env);
        for _ in 0..count {
            let owner = Address::generate(&fixture.env);
            fixture.client.add_owner(&fixture.owner.clone(), &owner);
            extra.push_back(owner);
        }
        (fixture, extra)
    }

    /// A `Bytes` payload of `len` bytes whose contents are unique per `seed`.
    ///
    /// Uniqueness matters: `log_event` deduplicates identical
    /// (event_type, submitter, metadata) triples unless `force = true`.
    pub fn metadata(&self, len: usize, seed: u32) -> Bytes {
        let data: std::vec::Vec<u8> = (0..len).map(|i| (seed as u8).wrapping_add(i as u8)).collect();
        Bytes::from_slice(&self.env, &data)
    }

    /// Seed `count` events for `submitter` with `metadata_len`-byte payloads.
    ///
    /// Timestamps advance by one second per event, staying well inside the
    /// contract's one-hour drift window.
    pub fn seed_events(&self, count: u32, metadata_len: usize, event_type: &str) -> Vec<BytesN<32>> {
        self.seed_events_from(count, metadata_len, event_type, 0)
    }

    /// Like [`Fixture::seed_events`] but starts the metadata seed at `seed`.
    pub fn seed_events_from(&self, count: u32, metadata_len: usize, event_type: &str, seed: u32) -> Vec<BytesN<32>> {
        self.seed_events_multi(count, metadata_len, event_type, seed, None, None, false)
    }

    /// Seed `count` events with full control over category, sub-type and dedup.
    #[allow(clippy::too_many_arguments)]
    pub fn seed_events_multi(
        &self,
        count: u32,
        metadata_len: usize,
        event_type: &str,
        seed: u32,
        category: Option<&str>,
        sub_event_type: Option<&str>,
        force: bool,
    ) -> Vec<BytesN<32>> {
        let event_type = Symbol::new(&self.env, event_type);
        let category = category.map(|c| Symbol::new(&self.env, c));
        let sub_event_type = sub_event_type.map(|s| Symbol::new(&self.env, s));
        let mut ids = Vec::new(&self.env);
        // Base is the current ledger timestamp so a fixture seeded multiple
        // times keeps a strictly monotonic clock: the contract rejects any
        // event older than the previous one (issue #76).
        let base = self.env.ledger().timestamp();
        for i in 0..count {
            // One second per event: keeps the contract's monotonic-timestamp
            // invariant and makes time-based archival cutoffs meaningful.
            self.env.ledger().set_timestamp(base + u64::from(i));
            let metadata = self.metadata(metadata_len, seed.wrapping_add(i));
            let id = self.client.log_event(
                &self.submitter,
                &event_type,
                &metadata,
                &category,
                &sub_event_type,
                &force,
            );
            ids.push_back(id);
        }
        ids
    }

    /// Seed events spread across `types` event types, round-robin.
    pub fn seed_event_types(&self, types: &[&str], per_type: u32, metadata_len: usize) {
        for (i, event_type) in types.iter().enumerate() {
            self.seed_events_from(per_type, metadata_len, event_type, (i as u32) * 1_000);
        }
    }
}

impl Default for Fixture {
    fn default() -> Self {
        Self::new()
    }
}

/// Test `Env`.
///
/// SDK 27 creates snapshots only under a libtest harness (`test_state.test_name`
/// is unset here), so a plain `Env::default()` writes no snapshot files for the
/// benchmark runs and no custom test-Env configuration is needed.
fn test_env() -> Env {
    Env::default()
}
