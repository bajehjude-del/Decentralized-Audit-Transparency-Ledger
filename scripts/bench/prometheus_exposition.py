#!/usr/bin/env python3
"""Render a harness report as a Prometheus text-exposition file.

The benchmark report is the historical record; this turns one report into the
metric shape that the Grafana dashboard in
`monitoring/grafana/dashboards/contract-benchmarks.json` graphs, so a trend is a
matter of pushing each run to a Pushgateway and letting Prometheus scrape it.

Every series carries `suite` and `case` labels, which is what lets the dashboard
break cost down per entry point rather than showing one opaque total.

Usage:
    prometheus_exposition.py --report benchmarks/results/benchmark-report.json \\
                             --out benchmarks/results/benchmark-metrics.prom
    prometheus_exposition.py --report report.json --print     # to stdout
    cat report.json | prometheus_exposition.py --history benchmarks/history
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from typing import Any, Iterable

#: (metric name, help text, value extractor). All are "lower is better", so the
#: dashboard can use one shared threshold annotation across all of them.
RESOURCE_METRICS: tuple[tuple[str, str, str], ...] = (
    ("audit_ledger_bench_instructions", "Modelled CPU instructions per unit", "instructions"),
    ("audit_ledger_bench_fee_stroops", "Simulated transaction fee per unit, stroops", "fee_stroops"),
    ("audit_ledger_bench_memory_read_entries", "In-memory ledger entries read per unit", "memory_read_entries"),
    ("audit_ledger_bench_write_entries", "Ledger entries written per unit", "write_entries"),
    ("audit_ledger_bench_write_bytes", "Bytes written to the ledger per unit", "write_bytes"),
    ("audit_ledger_bench_mem_bytes", "Modelled contract memory footprint per unit", "mem_bytes"),
)

#: Single-value report-level metrics.
ARTIFACT_METRICS: tuple[tuple[str, str], ...] = (
    ("audit_ledger_bench_wasm_size_bytes", "Contract WASM artifact size in bytes"),
    ("audit_ledger_bench_wasm_within_limit", "1 when the WASM artifact is inside its size budget"),
    ("audit_ledger_bench_peak_rss_bytes", "Peak resident set size of the benchmark host process"),
    ("audit_ledger_bench_run_duration_seconds", "Wall-clock duration of the benchmark run"),
)

#: Gate metrics, read from the regression detector's JSON summary so the
#: dashboard's status tiles reflect a real comparison rather than a guess.
GATE_METRICS: tuple[tuple[str, str], ...] = (
    ("audit_ledger_bench_regressions", "Benchmark regressions beyond the threshold"),
    ("audit_ledger_bench_improvements", "Benchmark improvements beyond the threshold"),
    ("audit_ledger_bench_max_regression_pct", "Worst single regression, percent"),
    ("audit_ledger_bench_threshold_pct", "Configured regression threshold, percent"),
    ("audit_ledger_bench_cases_measured", "Benchmark cases measured in the run"),
    ("audit_ledger_bench_new_cases", "Cases present in this run but not in the baseline"),
    ("audit_ledger_bench_removed_cases", "Cases present in the baseline but not in this run"),
    ("audit_ledger_bench_gate_passed", "1 when the regression gate passed"),
)

#: Field name in the detector's summary for each gate metric.
GATE_FIELDS = {
    "audit_ledger_bench_regressions": "regression_count",
    "audit_ledger_bench_improvements": "improvement_count",
    "audit_ledger_bench_max_regression_pct": "max_regression_pct",
    "audit_ledger_bench_threshold_pct": "threshold_pct",
    "audit_ledger_bench_cases_measured": "cases_measured",
    "audit_ledger_bench_new_cases": "new_case_count",
    "audit_ledger_bench_removed_cases": "removed_case_count",
}

LABELS = {
    "audit_ledger_bench_instructions": "CPU instructions",
    "audit_ledger_bench_fee_stroops": "fee",
    "audit_ledger_bench_memory_read_entries": "read entries",
    "audit_ledger_bench_write_entries": "write entries",
    "audit_ledger_bench_write_bytes": "write bytes",
    "audit_ledger_bench_mem_bytes": "memory bytes",
    "audit_ledger_bench_median_ns": "median wall-clock",
    "audit_ledger_bench_wasm_size_bytes": "WASM size",
    "audit_ledger_bench_peak_rss_bytes": "peak RSS",
    "audit_ledger_bench_run_duration_seconds": "run duration",
    "audit_ledger_bench_wasm_within_limit": "WASM within budget",
}


def escape(value: str) -> str:
    """Escape a label value for the text exposition format."""
    return value.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def format_value(value: Any) -> str:
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        # Six significant digits is Prometheus' own default resolution.
        return f"{value:.6g}"
    return "0"


def metadata_lines(seen: set[str], metrics: Iterable[tuple[str, str]]) -> list[str]:
    """Emit `# HELP`/`# TYPE` for `metrics`, skipping any already declared.

    A single exposition may be assembled from more than one source (a live
    report plus an archived history), and repeated metadata for one metric name
    is rejected by strict Prometheus parsers.
    """
    lines: list[str] = []
    for name, documentation in metrics:
        if name in seen:
            continue
        seen.add(name)
        lines.append(f"# HELP {name} {documentation}")
        lines.append(f"# TYPE {name} gauge")
    return lines


def render_report(report: dict[str, Any], seen: set[str] | None = None) -> list[str]:
    """Render one report to exposition lines."""
    seen = set() if seen is None else seen
    lines: list[str] = []
    environment = report.get("environment", {}) or {}
    common = (
        f'commit="{escape(str(report.get("tool", {}).get("commit", "unknown"))[:12])}",'
        f'sdk="{escape(str(environment.get("soroban_sdk", "unknown")))}"'
    )

    lines += metadata_lines(
        seen, ((name, documentation) for name, documentation, _ in RESOURCE_METRICS)
    )
    lines += metadata_lines(
        seen,
        [("audit_ledger_bench_median_ns", LABELS["audit_ledger_bench_median_ns"] + " (advisory, not gated)")]
        + list(ARTIFACT_METRICS),
    )

    for case in report.get("cases", []):
        # Rejected and failed cases have no comparable numbers; emitting zeroes
        # for them would make a dashboard dip to "free" rather than "unknown".
        if case.get("error") or case.get("expected_failure"):
            continue
        suite = escape(str(case.get("suite", "")))
        name = escape(str(case.get("name", "")))
        contract_fn = escape(str(case.get("contract_fn", "")))
        unit = escape(str(case.get("unit", "")))
        unit_count = case.get("unit_count", 1)
        labels = f'suite="{suite}",case="{name}",fn="{contract_fn}",unit="{unit}",n="{unit_count}",{common}'

        per_unit = case.get("per_unit") or {}
        for metric_name, _, leaf in RESOURCE_METRICS:
            lines.append(f"{metric_name}{{{labels}}} {format_value(per_unit.get(leaf, 0))}")

        median = (case.get("timing") or {}).get("median_ns")
        if median is not None:
            lines.append(f"audit_ledger_bench_median_ns{{{labels}}} {format_value(median)}")

    wasm = report.get("wasm") or {}
    if wasm.get("size_bytes") is not None:
        lines.append(
            f"audit_ledger_bench_wasm_size_bytes{{{common}}} {format_value(wasm['size_bytes'])}"
        )
        within = wasm.get("within_limit")
        if within is not None:
            lines.append(
                f"audit_ledger_bench_wasm_within_limit{{{common}}} {format_value(within)}"
            )

    host = report.get("host") or {}
    if host.get("peak_rss_bytes") is not None:
        lines.append(
            f"audit_ledger_bench_peak_rss_bytes{{{common}}} {format_value(host['peak_rss_bytes'])}"
        )
    if host.get("duration_secs") is not None:
        lines.append(
            f"audit_ledger_bench_run_duration_seconds{{{common}}} {format_value(host['duration_secs'])}"
        )

    return lines


def render_history(history_dir: str, seen: set[str] | None = None) -> list[str]:
    """Render every archived snapshot, tagged by date, as a trend series.

    Only the artifact-level metrics are emitted per snapshot: the per-case series
    are large and a dated archive is for answering "did the contract get bigger
    or slower over time", not for per-case drill-down (that is the live report's
    job).
    """
    seen = set() if seen is None else seen
    lines: list[str] = metadata_lines(seen, ARTIFACT_METRICS)

    for path in sorted(glob.glob(os.path.join(history_dir, "*.json"))):
        try:
            with open(path, encoding="utf-8") as handle:
                report = json.load(handle)
        except (OSError, json.JSONDecodeError) as error:
            print(f"warning: skipping {path}: {error}", file=sys.stderr)
            continue
        stamp = str(report.get("generated_at", ""))[:10]
        commit = str(report.get("tool", {}).get("commit", "unknown"))[:12]
        labels = f'date="{escape(stamp)}",commit="{escape(commit)}"'
        wasm = report.get("wasm") or {}
        if wasm.get("size_bytes") is not None:
            lines.append(
                f"audit_ledger_bench_wasm_size_bytes{{{labels}}} "
                f"{format_value(wasm['size_bytes'])}"
            )
        host = report.get("host") or {}
        if host.get("peak_rss_bytes") is not None:
            lines.append(
                f"audit_ledger_bench_peak_rss_bytes{{{labels}}} "
                f"{format_value(host['peak_rss_bytes'])}"
            )
        if host.get("duration_secs") is not None:
            lines.append(
                f"audit_ledger_bench_run_duration_seconds{{{labels}}} "
                f"{format_value(host['duration_secs'])}"
            )
    return lines


def render_gate(summary: dict[str, Any], seen: set[str] | None = None) -> list[str]:
    """Render the detector's summary as gate metrics."""
    seen = set() if seen is None else seen
    lines: list[str] = metadata_lines(seen, GATE_METRICS)
    commit = escape(str(summary.get("current_commit", "unknown"))[:12])
    baseline_commit = escape(str(summary.get("baseline_commit", "unknown"))[:12])
    labels = f'commit="{commit}",baseline="{baseline_commit}"'
    for metric, field in GATE_FIELDS.items():
        if field in summary:
            lines.append(f"{metric}{{{labels}}} {format_value(summary[field])}")
    lines.append(
        f'audit_ledger_bench_gate_passed{{{labels}}} '
        f'{1 if summary.get("gate") == "pass" else 0}'
    )
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Render a benchmark report as Prometheus text exposition."
    )
    parser.add_argument("--report", help="path to a harness report JSON")
    parser.add_argument("--history", help="directory of archived snapshots to render")
    parser.add_argument(
        "--regressions",
        help="JSON summary written by detect_regression.py --summary-out",
    )
    parser.add_argument("--out", help="write here instead of stdout")
    parser.add_argument(
        "--print", dest="to_stdout", action="store_true", help="write to stdout"
    )
    args = parser.parse_args(argv)

    if not args.report and not args.history and not args.regressions:
        parser.error("one of --report, --history or --regressions is required")

    lines: list[str] = []
    seen: set[str] = set()
    if args.history:
        lines += render_history(args.history, seen)
    if args.report:
        if not os.path.isfile(args.report):
            print(f"error: report not found: {args.report}", file=sys.stderr)
            return 2
        try:
            with open(args.report, encoding="utf-8") as handle:
                report = json.load(handle)
        except json.JSONDecodeError as error:
            print(f"error: {args.report} is not valid JSON: {error}", file=sys.stderr)
            return 2
        lines += render_report(report, seen)
    if args.regressions:
        if not os.path.isfile(args.regressions):
            print(f"error: summary not found: {args.regressions}", file=sys.stderr)
            return 2
        try:
            with open(args.regressions, encoding="utf-8") as handle:
                summary = json.load(handle)
        except json.JSONDecodeError as error:
            print(f"error: {args.regressions} is not valid JSON: {error}", file=sys.stderr)
            return 2
        lines += render_gate(summary, seen)

    body = "\n".join(lines) + "\n"
    if args.out and not args.to_stdout:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(body)
        print(f"wrote {args.out}")
    else:
        sys.stdout.write(body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
