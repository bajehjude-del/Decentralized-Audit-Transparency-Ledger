//! Scenario group: contract-enforced limits.
//!
//! Every other group measures what a call *costs*. This group measures where
//! the contract *stops accepting* a call, which is the number an integrator
//! needs in order to size a payload and a batch: the worst payload that is still
//! accepted, and the first payload that is rejected.
//!
//! The ceilings are contract-level (`ContractError::MetadataTooLarge`,
//! `ContractError::GlobalMaxLogsReached`, `ContractError::CallerNotOwner`), not
//! host-level, so the boundary is exact and every probe is deterministic.
//!
//! Rejected calls simply invoke the client normally: the SDK host escalates a
//! contract error into a panic, and the harness catches it and records which
//! limit tripped. Each such case declares `expect_panic`, so the run *fails* if
//! a rejection stops happening — that is what keeps the recorded boundary from
//! silently going stale.

use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Symbol, Vec};

use crate::support::fixture::{Fixture, DEFAULT_METADATA_LIMIT};
use crate::support::measure::{measure_call, Bench, CaseSpec};

/// Metadata ceiling in force for the default fixture.
///
/// `Fixture::new()` configures the cap explicitly at `initialize` time, so the
/// boundary under test is `DEFAULT_METADATA_LIMIT` (4 KiB) rather than the
/// contract's own 1 KiB `DEFAULT_MAX_METADATA_SIZE`, which only applies to a
/// deployment that passes zero.
const MAX_METADATA: usize = DEFAULT_METADATA_LIMIT as usize;

/// Global event cap used for the capacity probe: small enough to fill quickly.
const SMALL_EVENT_CAP: u32 = 8;

pub fn run(bench: &mut Bench) {
    metadata_boundary(bench);
    capacity_boundary(bench);
}

/// Where the metadata size ceiling sits, and what the largest accepted payload
/// costs.
fn metadata_boundary(bench: &mut Bench) {
    // The worst payload the contract accepts: the number that matters for gas
    // budgeting, since per-byte costs dominate the write path.
    measure_call(
        bench,
        CaseSpec::new("limits", "metadata/at_max_accepted", "log_event")
            .metadata(MAX_METADATA as u32)
            .notes("largest payload the configured cap accepts; worst-case write cost"),
        || (Fixture::new(), ()),
        |fixture, _| {
            let metadata = fixture.metadata(MAX_METADATA, 1);
            fixture.client.log_event(
                &fixture.submitter,
                &Symbol::new(&fixture.env, "limits"),
                &metadata,
                &None,
                &None,
                &false,
            );
            1
        },
    );

    // One byte past the ceiling: rejected with `MetadataTooLarge`.
    measure_call(
        bench,
        CaseSpec::new("limits", "metadata/over_max_rejected", "log_event")
            .metadata((MAX_METADATA + 1) as u32)
            .expect_panic("payload 1 byte over the configured cap is rejected"),
        || (Fixture::new(), ()),
        |fixture, _| {
            let metadata = fixture.metadata(MAX_METADATA + 1, 1);
            fixture.client.log_event(
                &fixture.submitter,
                &Symbol::new(&fixture.env, "limits"),
                &metadata,
                &None,
                &None,
                &false,
            );
            1
        },
    );

    // The same ceiling reached through the batch entry point, so the two paths
    // are known to share one boundary.
    measure_call(
        bench,
        CaseSpec::new("limits", "metadata/batch_over_max_rejected", "log_events")
            .metadata((MAX_METADATA + 1) as u32)
            .expect_panic("batch path enforces the same per-event metadata cap"),
        || (Fixture::new(), ()),
        |fixture, _| {
            // `log_events` takes a flat `Vec<(submitter, event_type, metadata)>`.
            let mut events = Vec::new(&fixture.env);
            for (index, len) in [64usize, MAX_METADATA + 1].into_iter().enumerate() {
                let metadata = fixture.metadata(len, index as u32);
                events.push_back((fixture.submitter.clone(), Symbol::new(&fixture.env, "limits"), metadata));
            }
            let count = events.len() as u64;
            fixture.client.log_events(&events);
            count
        },
    );
}

/// Where the global event capacity ceiling sits, and the cost of the last event
/// that still fits.
fn capacity_boundary(bench: &mut Bench) {
    // The final event that fits under the cap. Seeding happens in setup, which is
    // excluded from the measurement, so the timed invocation is exactly the one
    // that lands on the cap boundary.
    measure_call(
        bench,
        CaseSpec::new("limits", "capacity/last_event_within_cap", "log_event")
            .notes("the final event accepted before the global cap rejects writes"),
        || {
            let fixture = Fixture::with_caps(SMALL_EVENT_CAP, MAX_METADATA as u32);
            fixture.seed_events(SMALL_EVENT_CAP - 1, 128, "capacity");
            (fixture, ())
        },
        |fixture, _| {
            let metadata = fixture.metadata(128, 99);
            fixture.client.log_event(
                &fixture.submitter,
                &Symbol::new(&fixture.env, "capacity"),
                &metadata,
                &None,
                &None,
                &false,
            );
            1
        },
    );

    // One event past the cap: rejected with `GlobalMaxLogsReached`.
    measure_call(
        bench,
        CaseSpec::new("limits", "capacity/over_cap_rejected", "log_event")
            .expect_panic("ledger already at its configured global event cap"),
        || {
            let fixture = Fixture::with_caps(SMALL_EVENT_CAP, MAX_METADATA as u32);
            fixture.seed_events(SMALL_EVENT_CAP, 128, "capacity");
            (fixture, ())
        },
        |fixture, _| {
            let metadata = fixture.metadata(128, 100);
            fixture.client.log_event(
                &fixture.submitter,
                &Symbol::new(&fixture.env, "capacity"),
                &metadata,
                &None,
                &None,
                &false,
            );
            1
        },
    );

    // A non-owner attempting a governance write is rejected before any state is
    // touched — the cheapest possible rejection, and the one an integration test
    // hits most often.
    measure_call(
        bench,
        CaseSpec::new("limits", "auth/non_owner_rejected", "set_global_max_logs")
            .expect_panic("governance write attempted without owner authorisation"),
        || (Fixture::new(), ()),
        |fixture, _| {
            let stranger = Address::generate(&fixture.env);
            fixture.client.set_global_max_logs(&stranger, &50_000);
            1
        },
    );
}
