#!/usr/bin/env python3
"""Compare two AuditLedger benchmark reports and gate on performance regressions.

The benchmark harness (`cargo bench -p audit-ledger-bench`) emits a JSON report
whose resource numbers are metered by the Soroban host. Those numbers are
deterministic: they depend only on the scenario, never on the machine or the
run. Wall-clock numbers are *not* deterministic and are therefore reported but
excluded from the gate by default.

What is gated
-------------
* Resource regressions  -- ``per_unit.instructions``, ``per_unit.fee_stroops``
  and the ledger read/write entry counts. Any increase beyond the threshold
  fails. The issue's budget is 5%; ``--threshold`` overrides it.
* WASM size            -- growth beyond the threshold fails.
* Wall-clock           -- reported as advisory only, unless ``--gate-wall-clock``
  is passed. Kept out of the default gate because it is dominated by CI runner
  noise and would fail spuriously.

New, removed and renamed cases are reported as informational changes. A case
that disappears is flagged, because a silently-dropped case would also stop
being regression-checked.

Exit codes
----------
0  no regression beyond the threshold
1  a regression was detected
2  the inputs could not be used (missing file, schema mismatch, bad JSON)

Usage
-----
    detect_regression.py --baseline benchmarks/baseline.json \\
                         --current  benchmarks/results/benchmark-report.json \\
                         --threshold 5 \\
                         --markdown-out benchmarks/results/regression.md \\
                         --github-annotations
    detect_regression.py --baseline ... --current ... --update-baseline
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from typing import Any

SCHEMA_VERSION = 1
DEFAULT_THRESHOLD_PCT = 5.0

#: Keys compared per case. All of them are host-metered and therefore
#: deterministic; lower is better for every one of them.
RESOURCE_KEYS: tuple[tuple[str, str], ...] = (
    ("instructions", "per_unit.instructions"),
    ("fee_stroops", "per_unit.fee_stroops"),
    ("memory_read_entries", "per_unit.memory_read_entries"),
    ("write_entries", "per_unit.write_entries"),
    ("write_bytes", "per_unit.write_bytes"),
    ("disk_read_entries", "per_unit.disk_read_entries"),
    ("contract_events_size_bytes", "per_unit.contract_events_size_bytes"),
)


def die(message: str) -> "NoReturn":  # noqa: F821 - typing only
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(2)


@dataclass
class Change:
    """A single measured difference between the baseline and the current run."""

    case: str
    metric: str
    baseline: float
    current: float
    unit: str = ""

    @property
    def delta_pct(self) -> float:
        if self.baseline == 0:
            # A metric that was free and now costs something is a real
            # regression; a ratio against zero is undefined, so treat the first
            # non-zero reading as a 100% increase and let the caller report it.
            return float("inf") if self.current != 0 else 0.0
        return (self.current - self.baseline) / self.baseline * 100.0

    def render(self) -> str:
        pct = self.delta_pct
        pct_text = "+inf" if pct == float("inf") else f"{pct:+.1f}%"
        unit = f" {self.unit}" if self.unit else ""
        return (
            f"`{self.case}` {self.metric}: "
            f"{self.baseline:,.0f} -> {self.current:,.0f}{unit} ({pct_text})"
        )


@dataclass
class Report:
    """Parsed view of a harness report, indexed by case name."""

    path: str
    raw: dict[str, Any]
    cases: dict[str, dict[str, Any]] = field(default_factory=dict)
    wasm_size: int | None = None

    @property
    def generated_at(self) -> str:
        return str(self.raw.get("generated_at", "unknown"))

    @property
    def commit(self) -> str:
        return str(self.raw.get("tool", {}).get("commit", "unknown"))


def load(path: str) -> Report:
    if not os.path.isfile(path):
        die(f"report not found: {path}")
    try:
        with open(path, encoding="utf-8") as handle:
            raw = json.load(handle)
    except json.JSONDecodeError as error:
        die(f"{path} is not valid JSON: {error}")

    if not isinstance(raw, dict):
        die(f"{path}: expected a JSON object at the top level")

    version = raw.get("schema_version")
    if version != SCHEMA_VERSION:
        die(
            f"{path}: schema_version {version!r} is not supported "
            f"(this tool understands {SCHEMA_VERSION})"
        )

    report = Report(path=path, raw=raw)
    for case in raw.get("cases", []):
        name = f"{case.get('suite')}/{case.get('name')}"
        report.cases[name] = case

    wasm = raw.get("wasm") or {}
    size = wasm.get("size_bytes")
    report.wasm_size = int(size) if isinstance(size, int) else None
    return report


def metric_value(case: dict[str, Any], dotted: str) -> float:
    """Read a `per_unit.*` metric, treating a missing key as absent."""
    _, leaf = dotted.split(".", 1)
    block = case.get("per_unit") or {}
    value = block.get(leaf)
    return float(value) if isinstance(value, (int, float)) else 0.0


def compare(
    baseline: Report, current: Report, threshold: float, gate_wall_clock: bool
) -> tuple[list[Change], list[Change], list[str], list[str]]:
    """Return (regressions, improvements, new_cases, removed_cases)."""
    regressions: list[Change] = []
    improvements: list[Change] = []

    for name, base_case in baseline.cases.items():
        current_case = current.cases.get(name)
        if current_case is None:
            continue
        # A case that panicked in either run has no comparable numbers.
        if base_case.get("error") or current_case.get("error"):
            continue
        if base_case.get("expected_failure") or current_case.get("expected_failure"):
            continue

        unit = str(current_case.get("unit", ""))
        for metric, dotted in RESOURCE_KEYS:
            before = metric_value(base_case, dotted)
            after = metric_value(current_case, dotted)
            if before == after:
                continue
            change = Change(
                case=name, metric=metric, baseline=before, current=after, unit=unit
            )
            # An increase is a regression; a decrease is an improvement.
            if change.delta_pct > threshold:
                regressions.append(change)
            elif change.delta_pct < -threshold:
                improvements.append(change)

        if gate_wall_clock:
            before_ns = float((base_case.get("timing") or {}).get("median_ns") or 0)
            after_ns = float((current_case.get("timing") or {}).get("median_ns") or 0)
            if before_ns and after_ns and after_ns != before_ns:
                change = Change(
                    case=name,
                    metric="median_ns",
                    baseline=before_ns,
                    current=after_ns,
                    unit="ns",
                )
                if change.delta_pct > threshold:
                    regressions.append(change)
                elif change.delta_pct < -threshold:
                    improvements.append(change)

    new_cases = sorted(set(current.cases) - set(baseline.cases))
    removed_cases = sorted(set(baseline.cases) - set(current.cases))
    return regressions, improvements, new_cases, removed_cases


def compare_wasm(
    baseline: Report, current: Report, threshold: float
) -> tuple[list[Change], list[Change]]:
    """Compare WASM artifact size; `None` on either side disables the check."""
    if baseline.wasm_size is None or current.wasm_size is None:
        return [], []
    if baseline.wasm_size == current.wasm_size:
        return [], []
    change = Change(
        case="wasm",
        metric="size_bytes",
        baseline=float(baseline.wasm_size),
        current=float(current.wasm_size),
        unit="bytes",
    )
    if change.delta_pct > threshold:
        return [change], []
    if change.delta_pct < -threshold:
        return [], [change]
    return [], []


def build_markdown(
    baseline: Report,
    current: Report,
    regressions: list[Change],
    improvements: list[Change],
    new_cases: list[str],
    removed_cases: list[str],
    threshold: float,
) -> str:
    status = "REGRESSION" if regressions else "PASS"
    lines = [
        "## Contract benchmark regression check",
        "",
        f"**Result: {status}** (threshold {threshold:g}% increase)",
        "",
        f"- baseline: `{baseline.path}` "
        f"({len(baseline.cases)} cases, {baseline.generated_at})",
        f"- current: `{current.path}` "
        f"({len(current.cases)} cases, {current.generated_at})",
    ]
    if baseline.wasm_size is not None and current.wasm_size is not None:
        lines.append(
            f"- WASM: {baseline.wasm_size:,} -> {current.wasm_size:,} bytes"
        )

    if regressions:
        lines += ["", "### Regressions", "", "| Case | Metric | Before | After | Change |",
                  "| --- | --- | ---: | ---: | ---: |"]
        for change in sorted(regressions, key=lambda c: -c.delta_pct):
            pct = "+inf" if change.delta_pct == float("inf") else f"{change.delta_pct:+.1f}%"
            lines.append(
                f"| `{change.case}` | {change.metric} | {change.baseline:,.0f} "
                f"| {change.current:,.0f} | {pct} |"
            )

    if improvements:
        lines += ["", "### Improvements", ""]
        for change in sorted(improvements, key=lambda c: c.delta_pct)[:25]:
            lines.append(f"- {change.render()}")
        if len(improvements) > 25:
            lines.append(f"- … and {len(improvements) - 25} more")

    if new_cases:
        lines += ["", f"### New cases ({len(new_cases)})", ""]
        lines += [f"- `{name}`" for name in new_cases[:40]]
        if len(new_cases) > 40:
            lines.append(f"- … and {len(new_cases) - 40} more")

    if removed_cases:
        # Not a failure, but a silent hole in the coverage: these cases are no
        # longer regression-checked.
        lines += [
            "",
            f"> **Warning** — {len(removed_cases)} case(s) present in the baseline are "
            "absent from this run and are no longer being checked:",
            "",
        ]
        lines += [f"> - `{name}`" for name in removed_cases[:40]]

    if not regressions and not improvements and not new_cases and not removed_cases:
        lines += ["", "No measured differences."]

    return "\n".join(lines) + "\n"


def emit_github_annotations(regressions: list[Change]) -> None:
    """Emit workflow commands so regressions show up inline on the PR diff."""
    for change in regressions:
        pct = (
            "+inf"
            if change.delta_pct == float("inf")
            else f"{change.delta_pct:.1f}"
        )
        message = (
            f"{change.metric} increased {pct}% "
            f"({change.baseline:,.0f} -> {change.current:,.0f})"
        )
        print(f"::warning title=Benchmark regression::{message}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Gate on AuditLedger contract benchmark regressions."
    )
    parser.add_argument("--baseline", required=True, help="baseline report JSON")
    parser.add_argument("--current", required=True, help="current report JSON")
    parser.add_argument(
        "--threshold",
        type=float,
        default=DEFAULT_THRESHOLD_PCT,
        help=f"maximum tolerated increase in percent (default {DEFAULT_THRESHOLD_PCT})",
    )
    parser.add_argument(
        "--gate-wall-clock",
        action="store_true",
        help="also gate on wall-clock medians (noisy; off by default)",
    )
    parser.add_argument("--markdown-out", help="write the Markdown summary here")
    parser.add_argument(
        "--summary-out",
        help="write a machine-readable JSON summary here (consumed by the "
        "Prometheus exporter and the Grafana dashboard)",
    )
    parser.add_argument(
        "--github-annotations",
        action="store_true",
        help="print ::warning workflow commands for each regression",
    )
    parser.add_argument(
        "--max-annotations",
        type=int,
        default=25,
        help="cap on emitted annotations (default 25)",
    )
    parser.add_argument(
        "--update-baseline",
        action="store_true",
        help="promote the current report to the baseline and exit",
    )
    args = parser.parse_args(argv)

    baseline = load(args.baseline)
    current = load(args.current)

    if args.update_baseline:
        # Re-stamp the promoted baseline so its provenance is self-describing.
        promoted = dict(current.raw)
        promoted["promoted_from"] = baseline.commit
        with open(args.baseline, "w", encoding="utf-8") as handle:
            json.dump(promoted, handle, indent=2)
            handle.write("\n")
        print(
            f"baseline updated from {args.baseline} "
            f"({len(current.cases)} cases, commit {current.commit[:7]})"
        )
        return 0

    regressions, improvements, new_cases, removed_cases = compare(
        baseline, current, args.threshold, args.gate_wall_clock
    )
    wasm_regressions, wasm_improvements = compare_wasm(
        baseline, current, args.threshold
    )
    regressions += wasm_regressions
    improvements += wasm_improvements

    summary = build_markdown(
        baseline,
        current,
        regressions,
        improvements,
        new_cases,
        removed_cases,
        args.threshold,
    )
    print(summary)

    if args.markdown_out:
        os.makedirs(os.path.dirname(os.path.abspath(args.markdown_out)), exist_ok=True)
        with open(args.markdown_out, "w", encoding="utf-8") as handle:
            handle.write(summary)

    if args.summary_out:
        finite = [
            change.delta_pct
            for change in regressions
            if change.delta_pct != float("inf")
        ]
        payload = {
            "generated_at": current.generated_at,
            "threshold_pct": args.threshold,
            "regression_count": len(regressions),
            "improvement_count": len(improvements),
            "new_case_count": len(new_cases),
            "removed_case_count": len(removed_cases),
            "max_regression_pct": max(finite) if finite else 0.0,
            "cases_measured": len(current.cases),
            "baseline_commit": baseline.commit,
            "current_commit": current.commit,
            "wasm_size_bytes": current.wasm_size,
            "gate": "fail" if regressions else "pass",
        }
        os.makedirs(os.path.dirname(os.path.abspath(args.summary_out)), exist_ok=True)
        with open(args.summary_out, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")

    if args.github_annotations:
        for change in sorted(regressions, key=lambda c: -c.delta_pct)[
            : args.max_annotations
        ]:
            emit_github_annotations([change])
        if len(regressions) > args.max_annotations:
            print(
                f"::warning title=Benchmark regression::"
                f"{len(regressions) - args.max_annotations} further regressions "
                f"not annotated; see the job summary."
            )

    if regressions:
        print(
            f"\n{len(regressions)} regression(s) beyond the "
            f"{args.threshold:g}% threshold.",
            file=sys.stderr,
        )
        return 1

    print(f"\nNo regressions beyond the {args.threshold:g}% threshold.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
