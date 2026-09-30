//! Scenario group: archival, snapshots and lifecycle cleanup.
//!
//! Archiving moves events from the hot ledger into (optionally compressed or
//! off-chain referenced) cold storage, so it is the only read-mostly operation
//! in the contract that also *removes* live entries. These cases quantify the
//! cost of one archival batch and of the bounded maintenance calls
//! (`cleanup_*`, `compact_storage`).

use audit_ledger::ArchiveConfig;
use soroban_sdk::{Bytes, Symbol, Vec};

use crate::support::fixture::{Fixture, BASE_TIMESTAMP};
use crate::support::measure::{measure_call, Bench, CaseSpec};

/// Events seeded before an archival run.
///
/// Bounded by the 64 KiB per-entry cap on the ledger's instance storage: a
/// 64-byte event costs roughly 1.1 KiB of instance accounting, so seeding past
/// ~50 events traps the harness (the contract itself cannot hold more).
const SEEDED_EVENTS: u32 = 40;

pub fn run(bench: &mut Bench) {
    archival_writes(bench);
    archival_reads(bench);
    purge(bench);
    snapshots(bench);
    maintenance(bench);
}

/// `archive_events` over batches of different sizes.
fn archival_writes(bench: &mut Bench) {
    for size in [10u32, 30, 60] {
        let name = format!("archive_events/{size}_events");
        let notes = format!("archive the oldest {size} of {SEEDED_EVENTS} events");
        bench.measure(
            CaseSpec::new("archive", &name, "archive_events")
                .unit("event")
                .notes(&notes),
            move || {
                let fixture = Fixture::new();
                fixture.seed_events(SEEDED_EVENTS, 64, "transfer");
                fixture.without_resource_limits();
                let owner = fixture.owner.clone();
                (fixture, owner)
            },
            move |fixture, owner, _| fixture.client.archive_events(owner, &(BASE_TIMESTAMP + size as u64)) as u64,
        );
    }

    measure_call(
        bench,
        CaseSpec::new("archive", "archive_events_offchain", "archive_events")
            .unit("event")
            .notes("payloads replaced by URI + checksum references"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            let config = ArchiveConfig {
                offchain_storage: true,
                base_url: Bytes::from_slice(&fixture.env, b"https://cdn.example.com/audit/"),
                compression: 0,
            };
            fixture.client.set_archive_config(&owner, &config);
            fixture.seed_events(SEEDED_EVENTS, 64, "transfer");
            fixture.without_resource_limits();
            (fixture, owner)
        },
        |fixture, owner| fixture.client.archive_events(owner, &(BASE_TIMESTAMP + 30)) as u64,
    );

    measure_call(
        bench,
        CaseSpec::new("archive", "archive_events_rle_compressed", "archive_events")
            .unit("event")
            .notes("run-length encoded cold metadata (compression = 1)"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            let config = ArchiveConfig {
                offchain_storage: false,
                base_url: Bytes::new(&fixture.env),
                compression: 1,
            };
            fixture.client.set_archive_config(&owner, &config);
            // Highly compressible payloads make the RLE path representative.
            let event_type = Symbol::new(&fixture.env, "transfer");
            let submitter = fixture.submitter.clone();
            for i in 0..SEEDED_EVENTS {
                let metadata = fixture.metadata(64, 0);
                fixture
                    .client
                    .log_event(&submitter, &event_type, &metadata, &None, &None, &(i > 0));
            }
            fixture.without_resource_limits();
            (fixture, owner)
        },
        |fixture, owner| fixture.client.archive_events(owner, &(BASE_TIMESTAMP + 30)) as u64,
    );
}

/// Reads against the cold store.
fn archival_reads(bench: &mut Bench) {
    measure_call(
        bench,
        CaseSpec::new("archive", "get_archived_event", "get_archived_event")
            .notes("full cold payload for an archived id"),
        archived_fixture(),
        |fixture, id| {
            let _ = fixture.client.get_archived_event(id);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new("archive", "get_archived_event_ref", "get_archived_event_ref")
            .notes("off-chain reference (URI + checksum)"),
        || {
            let (fixture, ids) = archived_fixture_with_ids();
            (fixture, ids)
        },
        |fixture, ids| {
            let id = ids.get(0).unwrap();
            let _ = fixture.client.get_archived_event_ref(&id);
            1
        },
    );

    measure_call(
        bench,
        CaseSpec::new(
            "archive",
            "verify_archived_event_checksum",
            "verify_archived_event_checksum",
        )
        .notes("re-hashes the candidate payload"),
        || {
            let (fixture, ids) = archived_fixture_with_ids();
            let id = ids.get(0).unwrap();
            let event = fixture.client.get_archived_event(&id);
            (fixture, (id, event))
        },
        |fixture, args| {
            let (id, event) = args;
            fixture.client.verify_archived_event_checksum(id, event) as u64
        },
    );

    measure_call(
        bench,
        CaseSpec::new("archive", "list_archived_events/limit_50", "list_archived_events")
            .unit("page")
            .notes("page over the cold index"),
        || {
            let (fixture, _) = archived_fixture_with_ids();
            (fixture, ())
        },
        |fixture, _| fixture.client.list_archived_events(&0, &50).len() as u64,
    );

    measure_call(
        bench,
        CaseSpec::new("archive", "get_archived_event_count", "get_archived_event_count"),
        archived_fixture(),
        |fixture, _| fixture.client.get_archived_event_count() as u64,
    );

    measure_call(
        bench,
        CaseSpec::new("archive", "get_archive_stats", "get_archive_stats"),
        archived_fixture(),
        |fixture, _| {
            let _ = fixture.client.get_archive_stats();
            1
        },
    );
}

/// `purge_archived_events` — the destructive counterpart of archival.
fn purge(bench: &mut Bench) {
    measure_call(
        bench,
        CaseSpec::new("archive", "purge_archived_events_confirmed", "purge_archived_events")
            .unit("event")
            .notes("confirm = true removes the cold entries"),
        || {
            let (fixture, _) = archived_fixture_with_ids();
            let owner = fixture.owner.clone();
            (fixture, owner)
        },
        |fixture, owner| {
            fixture
                .client
                .purge_archived_events(owner, &(BASE_TIMESTAMP + 100), &true) as u64
        },
    );
}

/// Snapshot creation and verification.
fn snapshots(bench: &mut Bench) {
    measure_call(
        bench,
        CaseSpec::new("archive", "create_snapshot/50_events", "create_snapshot")
            .notes("hash-chain walk over 50 events"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            fixture.seed_events(40, 64, "transfer");
            (fixture, owner)
        },
        |fixture, owner| {
            let description = Bytes::from_slice(&fixture.env, b"snapshot after 50 events");
            fixture.client.create_snapshot(owner, &description) as u64
        },
    );

    measure_call(
        bench,
        CaseSpec::new("archive", "verify_snapshot/50_events", "verify_snapshot")
            .notes("re-walks the chain to the snapshot head"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            fixture.seed_events(40, 64, "transfer");
            let description = Bytes::from_slice(&fixture.env, b"snapshot after 50 events");
            let id = fixture.client.create_snapshot(&owner, &description);
            (fixture, id)
        },
        |fixture, id| fixture.client.verify_snapshot(id) as u64,
    );
}

/// Bounded maintenance sweeps.
fn maintenance(bench: &mut Bench) {
    measure_call(
        bench,
        CaseSpec::new("archive", "cleanup_expired_events/batch_25", "cleanup_expired_events")
            .unit("event")
            .notes("TTL is enabled so every event is a cleanup candidate"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            fixture.client.set_event_ttl(&owner, &1);
            fixture.seed_events(25, 64, "transfer");
            fixture.without_resource_limits();
            (fixture, owner)
        },
        |fixture, owner| fixture.client.cleanup_expired_events(owner, &0, &25) as u64,
    );

    measure_call(
        bench,
        CaseSpec::new("archive", "cleanup_stale_hashes/batch_25", "cleanup_stale_hashes")
            .unit("event")
            .notes("two superseded events are detected as stale"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            fixture.seed_events(25, 64, "transfer");
            fixture.client.update_event(&owner, &5, &fixture.metadata(64, 900));
            fixture.client.update_event(&owner, &10, &fixture.metadata(64, 901));
            fixture.without_resource_limits();
            (fixture, owner)
        },
        |fixture, owner| fixture.client.cleanup_stale_hashes(owner, &0, &25) as u64,
    );

    measure_call(
        bench,
        CaseSpec::new(
            "archive",
            "cleanup_stale_dedup_entries/batch_25",
            "cleanup_stale_dedup_entries",
        )
        .unit("event")
        .notes("dedup map entries whose event was superseded"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            fixture.seed_events(25, 64, "transfer");
            fixture.client.update_event(&owner, &5, &fixture.metadata(64, 900));
            fixture.without_resource_limits();
            (fixture, owner)
        },
        |fixture, owner| fixture.client.cleanup_stale_dedup_entries(owner, &0, &25) as u64,
    );

    measure_call(
        bench,
        CaseSpec::new("archive", "compact_storage", "compact_storage").notes("drops the index of an uncapped type"),
        || {
            let fixture = Fixture::new();
            let owner = fixture.owner.clone();
            let event_type = Symbol::new(&fixture.env, "transfer");
            fixture.client.set_event_max_logs(&owner, &event_type, &1_000);
            fixture.seed_events(10, 64, "transfer");
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
}

/// Fixture with 30 archived events; the argument is the first archived ID.
fn archived_fixture() -> impl FnMut() -> (Fixture, soroban_sdk::BytesN<32>) {
    || {
        let (fixture, ids) = archived_fixture_with_ids();
        let id = ids.get(0).unwrap();
        (fixture, id)
    }
}

/// Fixture with 30 archived events plus every archived event ID.
fn archived_fixture_with_ids() -> (Fixture, Vec<soroban_sdk::BytesN<32>>) {
    let fixture = Fixture::new();
    let owner = fixture.owner.clone();
    let ids = fixture.seed_events(SEEDED_EVENTS, 64, "transfer");
    fixture.without_resource_limits();
    fixture.client.archive_events(&owner, &(BASE_TIMESTAMP + 30));
    let mut archived = Vec::new(&fixture.env);
    for i in 0..ids.len() {
        archived.push_back(ids.get(i).unwrap());
    }
    (fixture, archived)
}
