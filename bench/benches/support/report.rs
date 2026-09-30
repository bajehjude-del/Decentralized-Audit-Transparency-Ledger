//! Report schema plus JSON and Markdown serialisation for benchmark runs.
//!
//! The JSON document is the contract between the harness, the regression
//! detector, the history store and Grafana. Its layout is versioned through
//! `schema_version`; the regression tooling refuses to compare reports with
//! different schema versions.

use std::fs;
use std::io;
use std::path::Path;

use serde::Serialize;

use super::metrics::Case;

/// Bump when the JSON layout changes incompatibly.
pub const SCHEMA_VERSION: u32 = 1;

/// Tool identification written into every report.
#[derive(Debug, Clone, Serialize)]
pub struct ToolInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub commit: String,
    pub branch: String,
    pub dirty: bool,
}

/// Where and how the run was executed.
#[derive(Debug, Clone, Serialize)]
pub struct EnvironmentInfo {
    pub os: String,
    pub arch: String,
    pub profile: String,
    pub iterations: u32,
    pub warmup: u32,
    pub soroban_sdk: &'static str,
    pub cpu_model: String,
    pub runner: Option<String>,
}

/// WASM artifact measurements (issue: WASM size benchmarks).
#[derive(Debug, Clone, Serialize)]
pub struct WasmInfo {
    pub path: String,
    pub size_bytes: Option<u64>,
    pub sha256: Option<String>,
    /// Maximum size the CI WASM-size job allows.
    pub limit_bytes: u64,
    pub within_limit: Option<bool>,
}

/// Host process measurements, filled in by `scripts/bench/run_benchmarks.sh`.
#[derive(Debug, Clone, Default, Serialize)]
pub struct HostInfo {
    /// Peak resident set size of the benchmark process, when measurable.
    pub peak_rss_bytes: Option<u64>,
    /// Wall-clock duration of the whole run.
    pub duration_secs: Option<f64>,
}

/// One complete benchmark run.
#[derive(Debug, Clone, Serialize)]
pub struct RunReport {
    pub schema_version: u32,
    /// RFC 3339 UTC timestamp of the run.
    pub generated_at: String,
    pub tool: ToolInfo,
    pub environment: EnvironmentInfo,
    pub wasm: WasmInfo,
    pub host: HostInfo,
    pub cases: Vec<Case>,
}

impl RunReport {
    /// Serialise the report as pretty JSON plus a machine-readable CSV.
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self)
            .unwrap_or_else(|error| format!("{{\"error\":\"failed to serialise report: {error}\"}}"))
    }

    /// Flat CSV of the per-unit comparison keys, one row per case.
    ///
    /// The `per_unit_*` volume columns are divided by `unit_count`; the
    /// `*_entries` columns are per invocation and deliberately not divided —
    /// see [`crate::support::metrics::Case::new`].
    pub fn to_csv(&self) -> String {
        let mut csv = String::new();
        csv.push_str(
            "generated_at,suite,name,contract_fn,unit,unit_count,metadata_bytes,per_unit_instructions,per_unit_fee_stroops,write_entries_per_invocation,read_entries_per_invocation,per_unit_write_bytes,invocation_instructions,invocation_fee_stroops,invocation_write_entries,median_ns,min_ns,spread\n",
        );
        for case in &self.cases {
            csv.push_str(&format!(
                "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{:.4}\n",
                self.generated_at,
                case.suite,
                case.name,
                case.contract_fn,
                case.unit,
                case.unit_count,
                case.metadata_bytes,
                case.per_unit.instructions,
                case.per_unit.fee_stroops,
                case.per_unit.write_entries,
                case.per_unit.memory_read_entries,
                case.per_unit.write_bytes,
                case.invocation.instructions,
                case.invocation.fee_stroops,
                case.invocation.write_entries,
                case.timing.median_ns,
                case.timing.min_ns,
                case.timing.spread,
            ));
        }
        csv
    }

    /// Human-readable Markdown summary, used for `$GITHUB_STEP_SUMMARY`,
    /// PR comments and `docs/performance/benchmark-results.md`.
    pub fn to_markdown(&self) -> String {
        let mut md = String::new();
        md.push_str("# AuditLedger contract benchmarks\n\n");
        md.push_str(&format!(
            "| Field | Value |\n| --- | --- |\n| Generated | {} |\n| Commit | `{}`{} |\n| Profile | {} |\n| Iterations | {} (warm-up {}) |\n| Host | {} {} |\n| Toolchain | soroban-sdk {} |\n",
            self.generated_at,
            short(&self.tool.commit),
            if self.tool.dirty { " (dirty)" } else { "" },
            self.environment.profile,
            self.environment.iterations,
            self.environment.warmup,
            self.environment.os,
            self.environment.arch,
            self.environment.soroban_sdk,
        ));
        md.push_str(&format!("\nCPU: {}\n", self.environment.cpu_model));

        match (self.wasm.size_bytes, self.wasm.within_limit) {
            (Some(size), Some(within)) => md.push_str(&format!(
                "\nWASM artifact: **{size} bytes** ({:.1} KiB) of a {} byte budget — {}\n",
                size as f64 / 1024.0,
                self.wasm.limit_bytes,
                if within { "within budget" } else { "OVER BUDGET" }
            )),
            _ => md.push_str("\nWASM artifact: not measured in this run\n"),
        }
        if let Some(rss) = self.host.peak_rss_bytes {
            md.push_str(&format!(
                "\nHost peak RSS: {rss} bytes ({:.1} MiB)\n",
                rss as f64 / 1_048_576.0
            ));
        }
        if let Some(duration) = self.host.duration_secs {
            md.push_str(&format!("Run duration: {duration:.1}s\n"));
        }

        let mut suites: Vec<&str> = self.cases.iter().map(|case| case.suite.as_str()).collect();
        suites.sort_unstable();
        suites.dedup();

        md.push_str("\n## Cases\n");
        md.push_str(
            "\nInstructions and fee are per unit of work. Ledger entry counts are per invocation, \
             since they describe the call rather than the units it produced.\n",
        );
        for suite in suites {
            md.push_str(&format!("\n### {suite}\n\n"));
            md.push_str(
                "| Case | Unit | Instructions | Fee (stroops) | Read entries | Write entries | Write bytes | Median ns | Notes |\n",
            );
            md.push_str("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |\n");
            for case in self.cases.iter().filter(|case| case.suite == suite) {
                if let Some(error) = &case.error {
                    md.push_str(&format!(
                        "| `{}` | — | — | — | — | — | — | — | :warning: {error} |\n",
                        case.name
                    ));
                    continue;
                }
                md.push_str(&format!(
                    "| `{}` | {}/{} | {} | {} | {} | {} | {} | {} | {} |\n",
                    case.name,
                    case.unit,
                    case.unit_count,
                    case.per_unit.instructions,
                    case.per_unit.fee_stroops,
                    case.per_unit.memory_read_entries,
                    case.per_unit.write_entries,
                    case.per_unit.write_bytes,
                    case.timing.median_ns,
                    if case.notes.is_empty() {
                        "-".to_string()
                    } else {
                        case.notes.clone()
                    },
                ));
            }
        }
        md
    }

    /// Write `report.json`, `report.csv` and `report.md` next to `dir`.
    pub fn write_to_dir(&self, dir: &Path, stem: &str) -> io::Result<Vec<std::path::PathBuf>> {
        fs::create_dir_all(dir)?;
        let mut written = Vec::new();
        for (suffix, body) in [
            ("json", self.to_json()),
            ("csv", self.to_csv()),
            ("md", self.to_markdown()),
        ] {
            let path = dir.join(format!("{stem}.{suffix}"));
            fs::write(&path, body)?;
            written.push(path);
        }
        Ok(written)
    }
}

/// First seven characters of a commit SHA, for compact report headers.
pub fn short(commit: &str) -> &str {
    commit.get(..7).unwrap_or(commit)
}
