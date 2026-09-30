//! Contract benchmark harness for `AuditLedger`.
//!
//! Run with:
//!
//! ```text
//! cargo bench -p audit-ledger-bench --bench contract_bench
//! ```
//!
//! Useful knobs (all have environment-variable equivalents so that CI can pass
//! them without rebuilding the benchmark list):
//!
//! | Flag | Env | Meaning |
//! | --- | --- | --- |
//! | `--iterations N` | `BENCH_ITERATIONS` | Timed invocations per case (default 7) |
//! | `--warmup N` | `BENCH_WARMUP` | Untimed invocations per case (default 1) |
//! | `--filter SUBSTR` | `BENCH_FILTER` | Only run `suite/name` containing SUBSTR |
//! | `--suite NAME` | `BENCH_SUITES` | Comma-separated suite allow-list |
//! | `--out-dir DIR` | `BENCH_OUT_DIR` | Where to write `report.{json,csv,md}` |
//! | `--fail-fast` | `BENCH_FAIL_FAST` | Abort on the first failing case |
//! | `--list-suites` | — | Print the available suite names and exit |
//!
//! Every measured invocation is metered by the Soroban host, so the resource
//! numbers in the report are deterministic. Wall-clock numbers depend on the
//! machine and are only advisory — see `docs/performance/benchmark-methodology.md`.

mod suites;
mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use support::measure::{Bench, Config};
use support::report::{EnvironmentInfo, HostInfo, RunReport, ToolInfo, WasmInfo, SCHEMA_VERSION};

/// Contract WASM budget enforced by the `wasm-size` CI job (128 KiB).
const WASM_SIZE_LIMIT_BYTES: u64 = 128 * 1024;
/// Report stem used for the JSON/CSV/Markdown outputs.
const REPORT_STEM: &str = "benchmark-report";
/// Harness flags cargo appends to the benchmark binary itself. They are not
/// part of our CLI and are dropped before argument parsing.
const CARGO_HARNESS_ARGS: &[&str] = &["--bench", "--test", "--no-fail-fast", "--nocapture"];

fn main() {
    std::process::exit(run());
}

fn run() -> i32 {
    let Some(cli) = parse_args() else {
        return 2;
    };
    let config = cli.config;

    if cli.list_suites {
        for suite in suites::SUITES {
            println!("{suite}");
        }
        return 0;
    }

    let total_cases = expected_case_count();
    println!(
        "AuditLedger contract benchmarks — {} iteration(s), {} warm-up, {} case group(s)",
        config.iterations,
        config.warmup,
        if config.suites.is_empty() {
            suites::SUITES.len()
        } else {
            config.suites.len()
        }
    );

    let started = Instant::now();
    let mut bench = Bench::new(config);
    suites::run_all(&mut bench);
    let duration = started.elapsed();

    let report = build_report(&bench, duration);
    write_outputs(&report);
    print_summary(&report);

    let failures = bench.failures();
    if !failures.is_empty() {
        eprintln!("\n{} case(s) failed:", failures.len());
        for failure in failures {
            eprintln!("  - {failure}");
        }
        eprintln!("\nReport written to {}", out_dir().display());
        return 1;
    }

    if report.cases.is_empty() {
        eprintln!(
            "no cases matched the filter; expected up to {} case groups",
            total_cases
        );
        return 1;
    }

    eprintln!("\nReport written to {}", out_dir().display());
    0
}

/// Configuration plus the one-shot `--list-suites` flag.
struct Cli {
    config: Config,
    list_suites: bool,
}

/// Parse `argv` over environment variables (flags win).
fn parse_args() -> Option<Cli> {
    let mut config = Config {
        iterations: env_u32("BENCH_ITERATIONS").unwrap_or(config_default_iterations()),
        warmup: env_u32("BENCH_WARMUP").unwrap_or(1),
        filter: env_string("BENCH_FILTER"),
        suites: env_string("BENCH_SUITES")
            .map(|value| {
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        fail_fast: env_flag("BENCH_FAIL_FAST"),
    };

    // Cargo appends its own harness flags to the benchmark binary (`--bench`
    // when invoked through `cargo bench`, or `--test`/`--bench --no-fail-fast`
    // depending on the cargo version). They are not ours, so drop them before
    // parsing; anything else is treated as a user argument.
    let args: Vec<String> = std::env::args()
        .skip(1)
        .filter(|arg| !CARGO_HARNESS_ARGS.contains(&arg.as_str()))
        .collect();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].clone();
        let takes_value = matches!(
            arg.as_str(),
            "--iterations" | "--warmup" | "--filter" | "--suite" | "--out-dir"
        );
        if takes_value {
            index += 1;
            let Some(raw) = args.get(index).cloned() else {
                eprintln!("{arg} expects a value");
                return None;
            };
            match arg.as_str() {
                "--iterations" | "--warmup" => {
                    let Ok(parsed) = raw.parse::<u32>() else {
                        eprintln!("{arg} expects a number, got {raw:?}");
                        return None;
                    };
                    if arg == "--iterations" {
                        config.iterations = parsed;
                    } else {
                        config.warmup = parsed;
                    }
                }
                "--filter" => config.filter = Some(raw),
                "--suite" => {
                    config.suites = raw
                        .split(',')
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                        .map(str::to_string)
                        .collect()
                }
                _ => {
                    // `--out-dir` is read back through the environment so that
                    // the writer path stays a single source of truth.
                    std::env::set_var("BENCH_OUT_DIR", raw);
                }
            }
        } else {
            match arg.as_str() {
                "--fail-fast" => config.fail_fast = true,
                "--list-suites" => {
                    return Some(Cli {
                        config,
                        list_suites: true,
                    })
                }
                "--help" | "-h" => {
                    print_usage();
                    return None;
                }
                other => {
                    eprintln!("unknown argument {other:?}\n");
                    print_usage();
                    return None;
                }
            }
        }
        index += 1;
    }

    if config.iterations == 0 {
        eprintln!("--iterations must be at least 1");
        return None;
    }
    for suite in &config.suites {
        if !suites::SUITES.contains(&suite.as_str()) {
            eprintln!("unknown suite {suite:?}; known suites: {}", suites::SUITES.join(", "));
            return None;
        }
    }

    Some(Cli {
        config,
        list_suites: false,
    })
}

fn print_usage() {
    eprintln!(
        "usage: cargo bench -p audit-ledger-bench --bench contract_bench -- [options]

  --iterations N   timed invocations per case
  --warmup N       untimed invocations per case
  --filter SUBSTR  only run suite/name cases containing SUBSTR
  --suite NAME     comma-separated suite allow-list ({})
  --out-dir DIR    report output directory (default {})
  --fail-fast      abort on the first failing case
  --list-suites    print the available suites
  -h, --help       show this message",
        suites::SUITES.join(", "),
        out_dir().display()
    );
}

/// Assemble the report from the collected cases plus host/artifact facts.
fn build_report(bench: &Bench, duration: std::time::Duration) -> RunReport {
    let config = bench.config();
    RunReport {
        schema_version: SCHEMA_VERSION,
        generated_at: rfc3339_now(),
        tool: ToolInfo {
            name: "audit-ledger-bench",
            version: env!("CARGO_PKG_VERSION"),
            commit: git(&["rev-parse", "HEAD"]),
            branch: git(&["rev-parse", "--abbrev-ref", "HEAD"]),
            dirty: !git(&["status", "--porcelain"]).is_empty(),
        },
        environment: EnvironmentInfo {
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            profile: profile(),
            iterations: config.iterations,
            warmup: config.warmup,
            soroban_sdk: "27.0.6",
            cpu_model: cpu_model(),
            runner: env_string("BENCH_RUNNER"),
        },
        wasm: wasm_info(),
        host: HostInfo {
            peak_rss_bytes: env_u64("BENCH_PEAK_RSS_BYTES").or_else(peak_rss_self),
            duration_secs: env_string("BENCH_DURATION_SECS")
                .and_then(|raw| raw.parse().ok())
                .or(Some(duration.as_secs_f64())),
        },
        cases: bench.cases().to_vec(),
    }
}

/// Locate and hash the built contract WASM, when it has been built.
fn wasm_info() -> WasmInfo {
    let limit = env_u64("WASM_SIZE_LIMIT_BYTES").unwrap_or(WASM_SIZE_LIMIT_BYTES);
    let root = repo_root();
    let path = env_string("WASM_PATH")
        .map(|value| rooted(PathBuf::from(value)))
        .unwrap_or_else(|| root.join("target/wasm32v1-none/release/audit_ledger.wasm"));
    let resolved = resolve_wasm_path(&path, &root);
    let (size_bytes, sha256) = match &resolved {
        Some(path) => match fs::read(path) {
            Ok(bytes) => (Some(bytes.len() as u64), Some(sha256_hex(&bytes))),
            Err(_) => (None, None),
        },
        None => (None, None),
    };
    let within_limit = size_bytes.map(|size| size <= limit);
    WasmInfo {
        path: resolved
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| path.display().to_string()),
        size_bytes,
        sha256,
        limit_bytes: limit,
        within_limit,
    }
}

/// Look for the WASM artifact in the usual build locations.
fn resolve_wasm_path(candidate: &Path, root: &Path) -> Option<PathBuf> {
    if candidate.exists() {
        return Some(candidate.to_path_buf());
    }
    for target in ["wasm32v1-none", "wasm32-unknown-unknown", "wasm32-wasmi"] {
        for profile in ["release", "debug"] {
            let alternative = root.join(format!("target/{target}/{profile}/audit_ledger.wasm"));
            if alternative.exists() {
                return Some(alternative);
            }
        }
    }
    None
}

/// The workspace root.
///
/// `cargo bench -p audit-ledger-bench` runs this binary with the *package*
/// directory as the working directory, so relative paths such as `target/…`
/// would otherwise resolve against `bench/` and the WASM artifact would never be
/// found. Walking up to the manifest that declares the workspace gives one
/// stable base for every path the harness resolves.
fn repo_root() -> PathBuf {
    if let Some(explicit) = env_string("BENCH_REPO_ROOT") {
        return PathBuf::from(explicit);
    }
    let mut current = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    loop {
        let manifest = current.join("Cargo.toml");
        if manifest.is_file()
            && std::fs::read_to_string(&manifest)
                .map(|body| body.contains("[workspace]"))
                .unwrap_or(false)
        {
            return current;
        }
        if !current.pop() {
            // No workspace manifest found; fall back to the invocation
            // directory so the run still produces output somewhere sensible.
            return std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        }
    }
}

/// Hex-encode the SHA-256 of `bytes`.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Write the JSON/CSV/Markdown report and append to the CI step summary.
fn write_outputs(report: &RunReport) {
    let dir = out_dir();
    match report.write_to_dir(&dir, REPORT_STEM) {
        Ok(paths) => {
            for path in paths {
                eprintln!("  wrote {}", path.display());
            }
        }
        Err(error) => eprintln!("warning: could not write report to {}: {error}", dir.display()),
    }
    if let Ok(summary_path) = std::env::var("GITHUB_STEP_SUMMARY") {
        match fs::OpenOptions::new().create(true).append(true).open(&summary_path) {
            Ok(mut file) => {
                use std::io::Write;
                let _ = writeln!(file, "\n{}", report.to_markdown());
            }
            Err(error) => eprintln!("warning: GITHUB_STEP_SUMMARY {summary_path}: {error}"),
        }
    }
}

/// Compact per-case table on stdout.
///
/// The `instr` and `fee` columns are per unit of work; the `wr`/`rd` entry
/// counts are per invocation, because they describe the call rather than the
/// units it produced.
fn print_summary(report: &RunReport) {
    println!(
        "\n{:<34} {:<12} {:>13} {:>12} {:>6} {:>6} {:>11}",
        "case", "unit", "instr/unit", "fee/unit", "wr/inv", "rd/inv", "median"
    );
    println!("{}", "-".repeat(102));
    for case in &report.cases {
        if let Some(error) = &case.error {
            println!(
                "{:<34} {:<12} {:>13}",
                format!("{}/{}", case.suite, case.name),
                "-",
                format!("FAILED: {error}")
            );
            continue;
        }
        if case.expected_failure {
            println!(
                "{:<34} {:<12} {:>13}",
                format!("{}/{}", case.suite, case.name),
                "-",
                "expected limit"
            );
            continue;
        }
        println!(
            "{:<34} {:<12} {:>13} {:>12} {:>8} {:>8} {:>11}",
            format!("{}/{}", case.suite, case.name),
            format!("{}/{}", case.unit, case.unit_count),
            case.per_unit.instructions,
            case.per_unit.fee_stroops,
            case.per_unit.write_entries,
            case.per_unit.memory_read_entries,
            format!("{:.1}us", case.timing.median_ns as f64 / 1_000.0),
        );
    }
    println!("{}", "-".repeat(102));

    let total = report.cases.len();
    let failed = report.cases.iter().filter(|case| !case.is_ok()).count();
    let limits = report.cases.iter().filter(|case| case.expected_failure).count();
    if let Some(size) = report.wasm.size_bytes {
        println!(
            "\nWASM: {} bytes ({:.1} KiB) of {} budget{}",
            size,
            size as f64 / 1024.0,
            report.wasm.limit_bytes,
            match report.wasm.within_limit {
                Some(true) => "",
                Some(false) => " — OVER BUDGET",
                None => "",
            }
        );
    } else {
        println!("\nWASM: not built (run `cargo build --target wasm32v1-none --release`)");
    }
    if let Some(rss) = report.host.peak_rss_bytes {
        println!("Host peak RSS: {:.1} MiB", rss as f64 / 1_048_576.0);
    }
    println!("Cases: {total} measured, {failed} failed, {limits} expected-limit probes");
}

/// Directory the report files are written to.
fn out_dir() -> PathBuf {
    env_string("BENCH_OUT_DIR")
        .map(|value| rooted(PathBuf::from(value)))
        .unwrap_or_else(|| repo_root().join("benchmarks/results"))
}

/// Anchor a possibly-relative path to the workspace root.
///
/// Every path the harness accepts on the command line or in the environment is
/// relative to the *repository*, not to the process working directory: cargo
/// runs a package's bench target with that package's directory as the CWD, so an
/// un-anchored `benchmarks/results` would silently land in `bench/`.
fn rooted(path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        repo_root().join(path)
    }
}

/// A rough count so an empty filter run is reported as a mistake.
fn expected_case_count() -> usize {
    suites::SUITES.len()
}

/// Build profile label recorded in the report.
fn profile() -> String {
    env_string("BENCH_PROFILE").unwrap_or_else(|| "release".to_string())
}

/// Best-effort CPU model for the report header.
fn cpu_model() -> String {
    if let Some(model) = env_string("BENCH_CPU_MODEL") {
        return model;
    }
    if let Ok(cpuinfo) = fs::read_to_string("/proc/cpuinfo") {
        for line in cpuinfo.lines() {
            if let Some(value) = line.strip_prefix("model name") {
                if let Some(model) = value.split(':').nth(1) {
                    return model.trim().to_string();
                }
            }
        }
    }
    if cfg!(target_os = "macos") {
        if let Ok(model) = Command::new("sysctl").args(["-n", "machdep.cpu.brand_string"]).output() {
            let model = String::from_utf8_lossy(&model.stdout).trim().to_string();
            if !model.is_empty() {
                return model;
            }
        }
    }
    "unknown".to_string()
}

/// Peak resident set size of this process, when the platform exposes it.
fn peak_rss_self() -> Option<u64> {
    let status = fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        if let Some(value) = line.strip_prefix("VmHWM:") {
            let kilobytes: u64 = value.trim().trim_end_matches(" kB").trim().parse().ok()?;
            return Some(kilobytes * 1024);
        }
    }
    None
}

/// Run `git` in the repository root, returning stdout or a placeholder.
fn git(args: &[&str]) -> String {
    let output = Command::new("git").args(args).output();
    match output {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout).trim().to_string(),
        _ => "unknown".to_string(),
    }
}

/// Current time as an RFC 3339 UTC timestamp.
fn rfc3339_now() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    format_rfc3339(seconds)
}

/// Format epoch seconds as `YYYY-MM-DDTHH:MM:SSZ` (proleptic Gregorian).
fn format_rfc3339(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let time_of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        time_of_day / 3_600,
        (time_of_day % 3_600) / 60,
        time_of_day % 60,
    )
}

/// Days since the Unix epoch to a civil date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 { shifted } else { shifted - 146_096 } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// Environment helper: non-empty string values only.
fn env_string(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn env_u32(name: &str) -> Option<u32> {
    env_string(name).and_then(|value| value.parse().ok())
}

fn env_u64(name: &str) -> Option<u64> {
    env_string(name).and_then(|value| value.parse().ok())
}

fn env_flag(name: &str) -> bool {
    matches!(env_string(name).as_deref(), Some("1" | "true" | "yes" | "on"))
}

fn config_default_iterations() -> u32 {
    // A single iteration keeps `cargo bench` usable while iterating locally.
    if cfg!(debug_assertions) {
        3
    } else {
        7
    }
}
