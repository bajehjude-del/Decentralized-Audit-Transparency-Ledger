//! Metric types for the benchmark suite.
//!
//! Two families of numbers are recorded for every case:
//!
//! * **Resource / gas metrics** — `instructions`, ledger entry read/write
//!   counts and byte volumes, contract event volume and the simulated fee in
//!   stroops. These come from the Soroban host invocation metering and are
//!   fully deterministic: they only depend on the scenario, never on the host.
//! * **Wall-clock metrics** — host timings of the invocation. These are noisy
//!   and are therefore only used for advisory checks (see
//!   `scripts/bench/detect_regression.py`).

use serde::Serialize;

/// A single resource/gas measurement, normalised per invocation.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Invocation {
    /// Modelled CPU instructions.
    pub instructions: i64,
    /// Modelled memory footprint in bytes.
    pub mem_bytes: i64,
    /// Ledger entries restored from disk.
    pub disk_read_entries: u32,
    /// In-memory ledger entries touched.
    pub memory_read_entries: u32,
    /// Ledger entries written.
    pub write_entries: u32,
    /// Bytes read from disk.
    pub disk_read_bytes: u32,
    /// Bytes written to the ledger.
    pub write_bytes: u32,
    /// Bytes of contract events emitted.
    pub contract_events_size_bytes: u32,
    /// Persistent rent bump volume (ledger-bytes).
    pub persistent_rent_ledger_bytes: i64,
    /// Number of persistent entries whose rent was bumped.
    pub persistent_entry_rent_bumps: u32,
    /// Temporary rent bump volume (ledger-bytes).
    pub temporary_rent_ledger_bytes: i64,
    /// Number of temporary entries whose rent was bumped.
    pub temporary_entry_rent_bumps: u32,
    /// Simulated transaction fee in stroops (mainnet fee schedule snapshot).
    pub fee_stroops: i64,
    /// Host budget CPU instructions.
    pub cpu_insns: u64,
    /// Host budget memory in bytes.
    pub budget_mem_bytes: u64,
    /// `ValSer` cost-tracker iterations.
    pub val_ser_ops: u64,
    /// `ValDeser` cost-tracker iterations.
    pub val_deser_ops: u64,
    /// `ComputeSha256Hash` cost-tracker iterations.
    pub sha256_ops: u64,
}

/// Wall-clock timings across the measured invocations of a case.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Timing {
    /// Number of timed invocations.
    pub iterations: u32,
    /// Number of untimed warm-up invocations.
    pub warmup: u32,
    /// Fastest observed invocation.
    pub min_ns: u64,
    /// Median observed invocation.
    pub median_ns: u64,
    /// Mean observed invocation.
    pub mean_ns: u64,
    /// Slowest observed invocation.
    pub max_ns: u64,
    /// Relative spread `(max - min) / median`; the suite's noise indicator.
    pub spread: f64,
}

/// A measured benchmark case with per-invocation and per-unit views.
#[derive(Debug, Clone, Serialize)]
pub struct Case {
    /// Scenario group (`single_event`, `batch`, `queries`, ...).
    pub suite: String,
    /// Stable, human readable case identifier used as the regression key.
    pub name: String,
    /// Contract entry point under measurement.
    pub contract_fn: String,
    /// What one "unit" means (`invocation`, `event`, `page`, `byte`).
    pub unit: String,
    /// Number of units produced by one invocation (e.g. events in a batch).
    pub unit_count: u64,
    /// Metadata payload size used by the case (0 when not applicable).
    pub metadata_bytes: u32,
    /// Free-form context (event type, pagination limit, ...).
    pub notes: String,
    /// Resource/gas metrics for one invocation.
    pub invocation: Invocation,
    /// The same metrics divided by `unit_count` — the headline comparison keys.
    pub per_unit: Invocation,
    /// Host wall-clock timings.
    pub timing: Timing,
    /// Panic message when the case could not be measured.
    pub error: Option<String>,
    /// The case asserts a contract failure (for example a mainnet resource
    /// limit being hit); its metrics are informational only.
    pub expected_failure: bool,
    /// Panic message of the intentional failure, recording which limit tripped.
    pub expected_failure_reason: Option<String>,
}

impl Case {
    /// Build a case, deriving the per-unit view from the per-invocation one.
    ///
    /// Not every metric is divided by `unit_count`. The *volume* metrics
    /// (instructions, fee, bytes, event size, rent) scale with the amount of
    /// work done, so per-unit is the meaningful comparison and is what shows a
    /// batch entry point amortising its fixed cost.
    ///
    /// The *operation-count* metrics (ledger entries read or written, rent bumps)
    /// describe the invocation as a whole and do not scale with the number of
    /// units. Dividing them would be actively misleading: a 5-event batch that
    /// writes 2 entries becomes `2 / 5 == 0` under integer division, which reads
    /// as "writes nothing" rather than "amortises writes across the batch". They
    /// are therefore carried through unchanged, and mean "per invocation".
    /// All nine fields are supplied from exactly one call site
    /// (`measure_inner`), which guarantees a case always carries a complete
    /// record; a builder would add machinery without removing the invariant.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        suite: &str,
        name: &str,
        contract_fn: &str,
        unit: &str,
        unit_count: u64,
        metadata_bytes: u32,
        notes: &str,
        invocation: Invocation,
        timing: Timing,
    ) -> Self {
        let divisor = unit_count.max(1);
        let d64 = divisor as i64;
        let d32 = divisor as u32;
        let per_unit = Invocation {
            // Volume metrics: divided.
            instructions: invocation.instructions / d64,
            mem_bytes: invocation.mem_bytes / d64,
            disk_read_bytes: invocation.disk_read_bytes / d32,
            write_bytes: invocation.write_bytes / d32,
            contract_events_size_bytes: invocation.contract_events_size_bytes / d32,
            persistent_rent_ledger_bytes: invocation.persistent_rent_ledger_bytes / d64,
            temporary_rent_ledger_bytes: invocation.temporary_rent_ledger_bytes / d64,
            fee_stroops: invocation.fee_stroops / d64,
            cpu_insns: invocation.cpu_insns / divisor,
            budget_mem_bytes: invocation.budget_mem_bytes / divisor,
            val_ser_ops: invocation.val_ser_ops / divisor,
            val_deser_ops: invocation.val_deser_ops / divisor,
            sha256_ops: invocation.sha256_ops / divisor,

            // Operation counts: per invocation, never divided.
            disk_read_entries: invocation.disk_read_entries,
            memory_read_entries: invocation.memory_read_entries,
            write_entries: invocation.write_entries,
            persistent_entry_rent_bumps: invocation.persistent_entry_rent_bumps,
            temporary_entry_rent_bumps: invocation.temporary_entry_rent_bumps,
        };
        let mut timing = timing;
        timing.spread = if timing.median_ns > 0 {
            (timing.max_ns.saturating_sub(timing.min_ns)) as f64 / timing.median_ns as f64
        } else {
            0.0
        };
        Self {
            suite: suite.to_string(),
            name: name.to_string(),
            contract_fn: contract_fn.to_string(),
            unit: unit.to_string(),
            unit_count,
            metadata_bytes,
            notes: notes.to_string(),
            invocation,
            per_unit,
            timing,
            error: None,
            expected_failure: false,
            expected_failure_reason: None,
        }
    }

    /// Mark the case as failed with `message`.
    pub fn with_error(mut self, message: String) -> Self {
        self.error = Some(message);
        self
    }

    /// Mark the case as an intentional contract failure and record why.
    pub fn with_expected_failure(mut self, reason: String) -> Self {
        self.expected_failure = true;
        self.expected_failure_reason = Some(reason);
        self.error = None;
        self
    }

    /// Whether the case measured successfully.
    pub fn is_ok(&self) -> bool {
        self.error.is_none()
    }
}
