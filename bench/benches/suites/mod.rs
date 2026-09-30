//! Scenario groups.
//!
//! Every group is a plain function taking [`Bench`], so a group can be skipped
//! with `--suite <name>` or a case with `--filter <substring>`.

pub mod archive;
pub mod batch;
pub mod governance;
pub mod limits;
pub mod queries;
pub mod single_event;
pub mod storage;

/// Default global event cap used by fixtures that do not override it.
pub const DEFAULT_MAX_EVENTS: u32 = 100_000;

/// Names of all scenario groups, in report order.
pub const SUITES: [&str; 7] = [
    "single_event",
    "batch",
    "queries",
    "governance",
    "archive",
    "storage",
    "limits",
];

/// Run every group whose name is not filtered out by `config`.
pub fn run_all(bench: &mut crate::support::measure::Bench) {
    let config = bench.config().clone();
    let selected = |name: &str| config.suites.is_empty() || config.suites.iter().any(|s| s == name);

    if selected("single_event") {
        single_event::run(bench);
    }
    if selected("batch") {
        batch::run(bench);
    }
    if selected("queries") {
        queries::run(bench);
    }
    if selected("governance") {
        governance::run(bench);
    }
    if selected("archive") {
        archive::run(bench);
    }
    if selected("storage") {
        storage::run(bench);
    }
    if selected("limits") {
        limits::run(bench);
    }
}
