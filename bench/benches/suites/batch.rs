//! Scenario group: batched event ingestion (`log_events`).
//!
//! Batch writes amortise the fixed per-invocation cost (auth, state read,
//! XDR envelope) over many events. These cases measure the amortisation curve
//! and locate the batch size at which a single transaction stops fitting into
//! the mainnet per-invocation resource limits.

use audit_ledger::DedupPolicy;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Bytes, Symbol, Vec};

use crate::suites::DEFAULT_MAX_EVENTS;
use crate::support::fixture::Fixture;
use crate::support::measure::{Bench, CaseSpec};

/// One `(submitter, event_type, metadata)` triple as accepted by `log_events`.
type BatchItem = (Address, Symbol, Bytes);

/// Batch sizes that fit inside the mainnet `write_entries` budget of 200.
const WITHIN_MAINNET_LIMITS: [u32; 4] = [1, 5, 10, 20];
/// Batch sizes that exceed it; measured with limit enforcement disabled.
// Batches that exceed the mainnet 200 write-entry budget but can still be
// driven with transaction resource limits disabled. A 100-event batch is
// excluded: its published events overflow the 16 KiB `contract_events_size`
// hard limit and the SDK aborts the harness.
const BEYOND_MAINNET_LIMITS: [u32; 2] = [25, 50];

pub fn run(bench: &mut Bench) {
    // ── Amortisation curve with 64 B metadata ────────────────────────────────
    for size in WITHIN_MAINNET_LIMITS {
        let name = format!("log_events/batch_{size}");
        let notes = notes_for(size);
        bench.measure(
            CaseSpec::new("batch", &name, "log_events")
                .unit("event")
                .metadata(64)
                .notes(&notes),
            move || {
                let fixture = Fixture::new();
                let batch = build_batch(&fixture, size, 64);
                (fixture, batch)
            },
            |fixture, batch, _| {
                let _ = fixture.client.log_events(batch);
                batch.len() as u64
            },
        );
    }

    // ── The same curve beyond the mainnet write budget ──────────────────────
    for size in BEYOND_MAINNET_LIMITS {
        let name = format!("log_events/batch_{size}_beyond_limits");
        let notes = format!(
            "{} — exceeds the mainnet 200 write-entry budget; resource limits disabled to model the cost",
            notes_for(size)
        );
        bench.measure(
            CaseSpec::new("batch", &name, "log_events")
                .unit("event")
                .metadata(64)
                .notes(&notes),
            move || {
                let fixture = Fixture::new();
                fixture.without_resource_limits();
                let batch = build_batch(&fixture, size, 64);
                (fixture, batch)
            },
            |fixture, batch, _| {
                let _ = fixture.client.log_events(batch);
                batch.len() as u64
            },
        );
    }

    // ── Metadata size sensitivity at a fixed batch size ─────────────────────
    for len in [0u32, 256, 1024] {
        let name = format!("log_events/batch_10_meta_{len}b");
        let notes = format!("batch of 10 events with {len} B metadata");
        bench.measure(
            CaseSpec::new("batch", &name, "log_events")
                .unit("event")
                .metadata(len)
                .notes(&notes),
            move || {
                let fixture = Fixture::new();
                let batch = build_batch(&fixture, 10, len);
                (fixture, batch)
            },
            |fixture, batch, _| {
                let _ = fixture.client.log_events(batch);
                batch.len() as u64
            },
        );
    }

    // ── Multi-submitter batch: one authorization per unique address ─────────
    bench.measure(
        CaseSpec::new("batch", "log_events/batch_10_mixed_submitters", "log_events")
            .unit("event")
            .metadata(64)
            .notes("10 events spread over 10 submitters (10 authorizations)"),
        || {
            let fixture = Fixture::new();
            let batch = build_batch_with_submitters(&fixture, 10, 64);
            (fixture, batch)
        },
        |fixture, batch, _| {
            let _ = fixture.client.log_events(batch);
            batch.len() as u64
        },
    );

    // ── Single-submitter batch with identical payloads under DedupPolicy::None
    bench.measure(
        CaseSpec::new("batch", "log_events/batch_20_dedup_disabled", "log_events")
            .unit("event")
            .metadata(64)
            .notes("identical payloads stored: DedupPolicy::None"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            fixture.client.set_dedup_policy(&owner, &DedupPolicy::None);
            let batch = build_batch_repeating(&fixture, 20, 64);
            (fixture, batch)
        },
        |fixture, batch, _| {
            let _ = fixture.client.log_events(batch);
            batch.len() as u64
        },
    );

    // ── low_cost_mode: batch without the per-type/submitter indexes ─────────
    bench.measure(
        CaseSpec::new("batch", "log_events/batch_20_low_cost_mode", "log_events")
            .unit("event")
            .metadata(64)
            .notes("index maintenance disabled"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            fixture.client.set_low_cost_mode(&owner, &true);
            let batch = build_batch(&fixture, 20, 64);
            (fixture, batch)
        },
        |fixture, batch, _| {
            let _ = fixture.client.log_events(batch);
            batch.len() as u64
        },
    );

    // ── Batch throttled by a tight global event cap ────────────────────────
    // A full 100-event write would overflow the 16 KiB `contract_events_size`
    // hard limit and abort the harness, so exercise 50 events under a hundred-stop cap.
    bench.measure(
        CaseSpec::new("batch", "log_events/batch_50_at_global_cap", "log_events")
            .unit("event")
            .metadata(64)
            .notes("global cap of 100 events, 50 written in one call"),
        || {
            let fixture = Fixture::with_caps(100, 4096);
            fixture.without_resource_limits();
            let batch = build_batch(&fixture, 50, 64);
            (fixture, batch)
        },
        |fixture, batch, _| {
            let _ = fixture.client.log_events(batch);
            batch.len() as u64
        },
    );
}

/// Build a batch of `size` events with unique payloads for a single submitter.
fn build_batch(fixture: &Fixture, size: u32, metadata_len: u32) -> Vec<BatchItem> {
    let submitter = fixture.submitter.clone();
    let event_type = Symbol::new(&fixture.env, "transfer");
    let mut batch = Vec::new(&fixture.env);
    for i in 0..size {
        let data: std::vec::Vec<u8> = (0..metadata_len as usize)
            .map(|j| (i as u8).wrapping_add(j as u8))
            .collect();
        batch.push_back((
            submitter.clone(),
            event_type.clone(),
            Bytes::from_slice(&fixture.env, &data),
        ));
    }
    batch
}

/// Build a batch where every event has a different submitter.
fn build_batch_with_submitters(fixture: &Fixture, size: u32, metadata_len: u32) -> Vec<BatchItem> {
    let event_type = Symbol::new(&fixture.env, "transfer");
    let mut batch = Vec::new(&fixture.env);
    for i in 0..size {
        let submitter = Address::generate(&fixture.env);
        let data: std::vec::Vec<u8> = (0..metadata_len as usize)
            .map(|j| (i as u8).wrapping_add(j as u8))
            .collect();
        batch.push_back((submitter, event_type.clone(), Bytes::from_slice(&fixture.env, &data)));
    }
    batch
}

/// Build a batch of identical payloads (requires `DedupPolicy::None`).
fn build_batch_repeating(fixture: &Fixture, size: u32, metadata_len: u32) -> Vec<BatchItem> {
    let submitter = fixture.submitter.clone();
    let event_type = Symbol::new(&fixture.env, "transfer");
    let data: std::vec::Vec<u8> = (0..metadata_len as usize).map(|j| j as u8).collect();
    let mut batch = Vec::new(&fixture.env);
    for _ in 0..size {
        batch.push_back((
            submitter.clone(),
            event_type.clone(),
            Bytes::from_slice(&fixture.env, &data),
        ));
    }
    batch
}

/// Human readable note describing where a batch size sits.
fn notes_for(size: u32) -> String {
    if size > 20 {
        format!("batch of {size} events (fixture capacity {})", DEFAULT_MAX_EVENTS)
    } else {
        format!("batch of {size} events, unique payloads")
    }
}
