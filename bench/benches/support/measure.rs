//! Measurement core: turns a scenario closure into a [`Case`] with resource
//! and wall-clock metrics.
//!
//! The measurement protocol is deliberately simple and is the basis of the
//! regression detection in `scripts/bench/detect_regression.py`:
//!
//! 1. Build a fresh [`Fixture`] and pre-build all invocation arguments.
//!    This setup work is **excluded** from every timing.
//! 2. Run `warmup` untimed invocations (first-call allocator/codec warm-up).
//! 3. Run `iterations` timed invocations, each against a fresh fixture.
//! 4. Read the Soroban host invocation metering after the last invocation.
//!    The host resets its budget before every top-level invocation, so the
//!    numbers describe exactly one invocation of the contract entry point.
//!
//! Only step 3 is timed, and only the invocation itself: argument construction
//! lives in the setup closure.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::Instant;

use soroban_sdk::testutils::budget::ContractCostType;
use soroban_sdk::Env;

use super::fixture::Fixture;
use super::metrics::{Case, Invocation, Timing};

/// Harness-wide knobs (all overridable from the command line / environment).
#[derive(Debug, Clone)]
pub struct Config {
    /// Timed invocations per case.
    pub iterations: u32,
    /// Untimed invocations per case.
    pub warmup: u32,
    /// Only run cases whose `suite/name` contains this substring.
    pub filter: Option<String>,
    /// Only run these suites (empty means all).
    pub suites: Vec<String>,
    /// Halt the whole run on the first failing case.
    pub fail_fast: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            iterations: 7,
            warmup: 1,
            filter: None,
            suites: Vec::new(),
            fail_fast: false,
        }
    }
}

impl Config {
    /// Whether a `suite`/`name` pair passes the filter configuration.
    pub fn should_run(&self, suite: &str, name: &str) -> bool {
        if !self.suites.is_empty() && !self.suites.iter().any(|s| s == suite) {
            return false;
        }
        match &self.filter {
            Some(filter) => format!("{suite}/{name}").contains(filter.as_str()),
            None => true,
        }
    }
}

/// Declarative description of one benchmark case.
#[derive(Debug, Clone)]
pub struct CaseSpec {
    pub suite: &'static str,
    pub name: String,
    pub contract_fn: &'static str,
    pub unit: &'static str,
    pub metadata_bytes: u32,
    pub notes: String,
    /// The invocation is expected to fail; the case then documents the limit
    /// instead of measuring cost.
    pub expect_panic: bool,
}

impl CaseSpec {
    /// Start a case description.
    pub fn new(suite: &'static str, name: &str, contract_fn: &'static str) -> Self {
        Self {
            suite,
            name: name.to_string(),
            contract_fn,
            unit: "invocation",
            metadata_bytes: 0,
            notes: String::new(),
            expect_panic: false,
        }
    }

    /// Unit of normalisation (`invocation`, `event`, `page`, `byte`).
    pub fn unit(mut self, unit: &'static str) -> Self {
        self.unit = unit;
        self
    }

    /// Metadata payload size the case exercises.
    pub fn metadata(mut self, bytes: u32) -> Self {
        self.metadata_bytes = bytes;
        self
    }

    /// Free-form context recorded alongside the metrics.
    pub fn notes(mut self, notes: &str) -> Self {
        self.notes = notes.to_string();
        self
    }

    /// Assert that the contract rejects the invocation (resource limits,
    /// validation rules) instead of measuring it.
    pub fn expect_panic(mut self, notes: &str) -> Self {
        self.expect_panic = true;
        self.notes = notes.to_string();
        self
    }
}

/// Collects [`Case`]s and drives the measurement protocol.
pub struct Bench {
    config: Config,
    cases: Vec<Case>,
    failures: Vec<String>,
}

impl Bench {
    /// Create a collector.
    pub fn new(config: Config) -> Self {
        Self {
            config,
            cases: Vec::new(),
            failures: Vec::new(),
        }
    }

    /// Harness configuration.
    pub fn config(&self) -> &Config {
        &self.config
    }

    /// Cases measured so far.
    pub fn cases(&self) -> &[Case] {
        &self.cases
    }

    /// Names of cases that panicked.
    pub fn failures(&self) -> &[String] {
        &self.failures
    }

    /// Measure a single case.
    ///
    /// `setup` builds a fresh fixture and the invocation arguments; `op`
    /// performs exactly one top-level contract invocation and returns the number
    /// of units it produced (events, rows, ...). The reported `unit_count` is
    /// the largest value observed across timed iterations.
    pub fn measure<A, S, I>(&mut self, spec: CaseSpec, mut setup: S, mut op: I)
    where
        S: FnMut() -> (Fixture, A),
        I: FnMut(&Fixture, &A, usize) -> u64,
    {
        if !self.config.should_run(spec.suite, &spec.name) {
            return;
        }

        let outcome = catch_unwind(AssertUnwindSafe(|| self.measure_inner(&spec, &mut setup, &mut op)));

        let case = match outcome {
            Ok(case) => {
                // A case declared `expect_panic` documents a resource or
                // validation limit. Reaching the end of the measurement without
                // the contract rejecting the invocation means the limit no longer
                // applies, which is a real finding — never a silent pass.
                if spec.expect_panic {
                    let message = "expected the contract to reject this invocation, but it succeeded".to_string();
                    eprintln!("  {}/{}: {}", spec.suite, spec.name, message);
                    self.failures.push(format!("{}/{}: {message}", spec.suite, spec.name));
                    case.with_error(message)
                } else {
                    case
                }
            }
            Err(payload) => {
                let message = panic_message(&payload);
                if spec.expect_panic {
                    // The SDK escalates a rejected invocation into a panic whose
                    // payload is not always a readable string, so the declared
                    // note is the authoritative reason and the payload text is
                    // only appended when it is actually informative.
                    let reason = if message_is_opaque(&message) {
                        spec.notes.clone()
                    } else {
                        format!("{} ({message})", spec.notes)
                    };
                    eprintln!("  {}/{}: expected failure ({reason})", spec.suite, spec.name);
                    Case::new(
                        spec.suite,
                        &spec.name,
                        spec.contract_fn,
                        spec.unit,
                        1,
                        spec.metadata_bytes,
                        &spec.notes,
                        Invocation::default(),
                        Timing {
                            iterations: 0,
                            warmup: self.config.warmup,
                            ..Timing::default()
                        },
                    )
                    .with_expected_failure(reason)
                } else {
                    eprintln!("  {}/{}: FAILED ({})", spec.suite, spec.name, message);
                    self.failures.push(format!("{}/{}: {message}", spec.suite, spec.name));
                    Case::new(
                        spec.suite,
                        &spec.name,
                        spec.contract_fn,
                        spec.unit,
                        1,
                        spec.metadata_bytes,
                        &spec.notes,
                        Invocation::default(),
                        Timing {
                            iterations: 0,
                            warmup: self.config.warmup,
                            ..Timing::default()
                        },
                    )
                    .with_error(message)
                }
            }
        };

        if case.error.is_none() && !case.expected_failure {
            eprintln!(
                "  {suite}/{name}: {instructions} instr, {fee} stroops, {read} read / {write} write entries, {min} ns",
                suite = case.suite,
                name = case.name,
                instructions = case.invocation.instructions,
                fee = case.invocation.fee_stroops,
                read = case.invocation.memory_read_entries,
                write = case.invocation.write_entries,
                min = case.timing.min_ns,
            );
        }

        self.cases.push(case);

        if self.config.fail_fast && !self.failures.is_empty() {
            panic!("benchmark case failed (fail_fast enabled): {}", self.failures[0]);
        }
    }

    fn measure_inner<A, S, I>(&self, spec: &CaseSpec, setup: &mut S, op: &mut I) -> Case
    where
        S: FnMut() -> (Fixture, A),
        I: FnMut(&Fixture, &A, usize) -> u64,
    {
        // Contract panics are expected for some scenarios; keep them out of the
        // harness output and restore the previous hook even when unwinding.
        let _silenced = SilencedPanicHook::install();

        let mut samples: Vec<u64> = Vec::with_capacity(self.config.iterations as usize);
        let mut invocation = Invocation::default();
        let mut unit_count: u64 = 1;

        for _ in 0..self.config.warmup {
            let (fixture, args) = setup();
            op(&fixture, &args, 0);
        }

        for iteration in 0..self.config.iterations {
            let (fixture, args) = setup();
            let started = Instant::now();
            let produced = op(&fixture, &args, (iteration + 1) as usize);
            samples.push(started.elapsed().as_nanos() as u64);
            invocation = capture(&fixture.env);
            unit_count = unit_count.max(produced);
        }

        let timing = summarise(samples, self.config.warmup);
        Case::new(
            spec.suite,
            &spec.name,
            spec.contract_fn,
            spec.unit,
            unit_count,
            spec.metadata_bytes,
            &spec.notes,
            invocation,
            timing,
        )
    }
}

/// Measure a case whose operation takes no extra arguments beyond the bundle
/// the setup closure already returned.
///
/// Saves the `|_| 1` unit-count boilerplate on the many single-invocation
/// governance and configuration cases.
pub fn measure_call<A, S, I>(bench: &mut Bench, spec: CaseSpec, setup: S, mut op: I)
where
    S: FnMut() -> (Fixture, A),
    I: FnMut(&Fixture, &A) -> u64,
{
    bench.measure(spec, setup, |fixture, args, _| op(fixture, args));
}

/// The hook registered before we replace it. It is deterministic to silence and
/// restore, but clippy's `very_complex_type` fires on the boxed trait object.
type PanicHook = Box<dyn Fn(&std::panic::PanicHookInfo<'_>) + Sync + Send + 'static>;

/// Temporarily replaces the global panic hook with a no-op.
struct SilencedPanicHook {
    previous: Option<PanicHook>,
}

impl SilencedPanicHook {
    fn install() -> Self {
        let previous = std::panic::take_hook();
        // `BENCH_NO_SILENCE=1` keeps the real hook so a panicking case prints
        // its message before being caught by `catch_unwind` (diagnostics).
        if std::env::var("BENCH_NO_SILENCE").is_err() {
            std::panic::set_hook(Box::new(|_| {}));
        }
        Self {
            previous: Some(previous),
        }
    }
}

impl Drop for SilencedPanicHook {
    fn drop(&mut self) {
        // Restore the previous hook — but never while the thread is unwinding
        // from a caught panic: `set_hook` panics from a panicking thread and
        // would turn every catchable failure into a double-panic abort.
        if !std::thread::panicking() {
            if let Some(previous) = self.previous.take() {
                std::panic::set_hook(previous);
            }
        }
    }
}

/// Read the host metering of the most recent top-level invocation.
fn capture(env: &Env) -> Invocation {
    let resources = env.cost_estimate().resources();
    let fee = env.cost_estimate().fee();
    let budget = env.cost_estimate().budget();
    let tracker = |cost_type: ContractCostType| budget.tracker(cost_type).iterations;

    Invocation {
        instructions: resources.instructions,
        mem_bytes: resources.mem_bytes,
        disk_read_entries: resources.disk_read_entries,
        memory_read_entries: resources.memory_read_entries,
        write_entries: resources.write_entries,
        disk_read_bytes: resources.disk_read_bytes,
        write_bytes: resources.write_bytes,
        contract_events_size_bytes: resources.contract_events_size_bytes,
        persistent_rent_ledger_bytes: resources.persistent_rent_ledger_bytes,
        persistent_entry_rent_bumps: resources.persistent_entry_rent_bumps,
        temporary_rent_ledger_bytes: resources.temporary_rent_ledger_bytes,
        temporary_entry_rent_bumps: resources.temporary_entry_rent_bumps,
        fee_stroops: fee.total,
        cpu_insns: budget.cpu_instruction_cost(),
        budget_mem_bytes: budget.memory_bytes_cost(),
        val_ser_ops: tracker(ContractCostType::ValSer),
        val_deser_ops: tracker(ContractCostType::ValDeser),
        sha256_ops: tracker(ContractCostType::ComputeSha256Hash),
    }
}

/// Reduce raw samples to min/median/mean/max plus a spread indicator.
fn summarise(mut samples: Vec<u64>, warmup: u32) -> Timing {
    if samples.is_empty() {
        return Timing {
            iterations: 0,
            warmup,
            ..Timing::default()
        };
    }
    samples.sort_unstable();
    let count = samples.len();
    let total: u128 = samples.iter().map(|s| *s as u128).sum();
    Timing {
        iterations: count as u32,
        warmup,
        min_ns: samples[0],
        median_ns: if count % 2 == 1 {
            samples[count / 2]
        } else {
            (samples[count / 2 - 1] + samples[count / 2]) / 2
        },
        mean_ns: (total / count as u128) as u64,
        max_ns: samples[count - 1],
        spread: 0.0,
    }
}

/// Best-effort extraction of the panic message from a caught payload.
///
/// A rejected contract invocation is escalated by the SDK host into a panic
/// whose payload type is an SDK implementation detail, so this is genuinely
/// best-effort — see [`message_is_opaque`] for how the result is used.
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return (*message).to_string();
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    if let Some(message) = payload.downcast_ref::<Box<str>>() {
        return message.to_string();
    }
    if let Some(error) = payload.downcast_ref::<soroban_sdk::Error>() {
        // `soroban_sdk::Error` is a newtype over `Val` and implements `Debug`
        // but not `Display`.
        return format!("{error:?}");
    }
    OPAQUE_PANIC.to_string()
}

/// Fallback recorded when the panic payload could not be read.
const OPAQUE_PANIC: &str = "opaque panic payload (SDK-escalated contract error)";

/// Whether [`panic_message`] failed to extract anything useful.
fn message_is_opaque(message: &str) -> bool {
    message == OPAQUE_PANIC
}
