#!/usr/bin/env python3
"""
simulate_upgrade.py — Simulate an upgrade by validating a candidate snapshot against a baseline.

Outputs a JSON report instead of human-readable text (though a summary is still printed).

Usage:
    python3 simulate_upgrade.py --baseline snapshots/baseline.json \
                                --candidate snapshots/current.json \
                                [--report upgrade-report.json]

Exit codes:
    0 — compatible
    1 — violations found
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from layout_utils import load_snapshot, validate_snapshots, compute_stats


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Simulate a contract upgrade and produce a JSON compatibility report."
    )
    parser.add_argument(
        "--baseline",
        required=True,
        help="Path to the baseline snapshot JSON.",
    )
    parser.add_argument(
        "--candidate",
        required=True,
        help="Path to the candidate (new) snapshot JSON.",
    )
    parser.add_argument(
        "--report",
        default=None,
        help="Optional path to write the JSON report to.",
    )
    args = parser.parse_args()

    # Load snapshots
    try:
        baseline = load_snapshot(args.baseline)
    except FileNotFoundError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"ERROR: Could not load baseline: {e}", file=sys.stderr)
        return 1

    try:
        candidate = load_snapshot(args.candidate)
    except FileNotFoundError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"ERROR: Could not load candidate: {e}", file=sys.stderr)
        return 1

    # Run validation
    violations, warnings = validate_snapshots(baseline, candidate)
    stats = compute_stats(baseline, candidate)

    compatible = len(violations) == 0

    # Build report
    report = {
        "compatible": compatible,
        "violations": [v.to_dict() for v in violations],
        "warnings": [w.to_dict() for w in warnings],
        "stats": stats,
        "baseline_commit": baseline.get("git_commit", "unknown"),
        "candidate_commit": candidate.get("git_commit", "unknown"),
        "contract": baseline.get("contract", "unknown"),
    }

    # Write report JSON if requested
    if args.report:
        report_path = Path(args.report)
        try:
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(f"Report written to: {report_path}")
        except OSError as e:
            print(f"ERROR: Could not write report: {e}", file=sys.stderr)
            return 1

    # Print human-readable summary
    print()
    print("═══════════════════════════════════════════")
    print("  Upgrade Simulation Report")
    print("═══════════════════════════════════════════")
    print(f"  Contract  : {report['contract']}")
    print(f"  Baseline  : {report['baseline_commit']}")
    print(f"  Candidate : {report['candidate_commit']}")
    print()
    print(f"  Compatible: {'YES' if compatible else 'NO'}")
    print()
    print(f"  Stats:")
    print(f"    Total (baseline) : {stats['total_old']}")
    print(f"    Total (candidate): {stats['total_new']}")
    print(f"    Added            : {stats['added']}")
    print(f"    Removed          : {stats['removed']}")
    print(f"    Changed          : {stats['changed']}")
    print()

    if violations:
        print(f"  VIOLATIONS ({len(violations)}):")
        for v in violations:
            print(f"    [{v.rule}] '{v.variant_name}' (ordinal={v.ordinal})")
            print(f"      {v.description}")
        print()

    if warnings:
        print(f"  WARNINGS ({len(warnings)}):")
        for w in warnings:
            print(f"    [{w.rule}] '{w.variant_name}' (ordinal={w.ordinal})")
            print(f"      {w.description}")
        print()

    if compatible:
        print("  ✓ Upgrade is SAFE to proceed.")
    else:
        print("  ✗ Upgrade has BREAKING changes — do NOT proceed without review.")
    print()

    return 0 if compatible else 1


if __name__ == "__main__":
    sys.exit(main())
