#!/usr/bin/env python3
"""
rollback_validate.py — Validates that rolling back to a previous version is safe.

CLI: --current snapshots/current.json --rollback-target snapshots/baseline.json

Logic:
- Checks that variants in rollback-target still match current (same ordinal, same fields).
- Checks that variants added in current but absent in rollback-target are not tombstones
  (rolling back re-exposes those keys).
- Outputs a JSON rollback safety report.

Exit codes:
    0 — safe to rollback
    1 — blockers found
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from layout_utils import load_snapshot, fields_equal


def validate_rollback(
    current_snapshot: dict,
    target_snapshot: dict,
) -> tuple[list[dict], list[dict]]:
    """
    Validate rollback safety.

    Returns (blockers, warnings).

    Blockers:
      - A variant in target has a different ordinal in current (ordinal drift).
      - A variant in target has different fields in current (type drift).

    Warnings:
      - A variant present in current but absent in target is non-tombstone
        (live data under those keys would be re-exposed after rollback).
    """
    blockers: list[dict] = []
    warnings: list[dict] = []

    current_variants: list[dict] = current_snapshot.get("variants", [])
    target_variants: list[dict] = target_snapshot.get("variants", [])

    current_by_name: dict[str, dict] = {v["name"]: v for v in current_variants}
    target_by_name: dict[str, dict] = {v["name"]: v for v in target_variants}
    current_by_ordinal: dict[int, dict] = {v["ordinal"]: v for v in current_variants}

    # Check: every variant in target must have the same ordinal and fields in current
    for name, target_var in target_by_name.items():
        if name in current_by_name:
            cur_var = current_by_name[name]
            # Ordinal must match
            if cur_var["ordinal"] != target_var["ordinal"]:
                blockers.append({
                    "type": "ordinal_mismatch",
                    "variant_name": name,
                    "target_ordinal": target_var["ordinal"],
                    "current_ordinal": cur_var["ordinal"],
                    "description": (
                        f"Variant '{name}' has ordinal {cur_var['ordinal']} in current "
                        f"but ordinal {target_var['ordinal']} in rollback target. "
                        "Rolling back would cause ordinal mismatch for this key."
                    ),
                })
            # Fields must match
            if not fields_equal(cur_var.get("fields", []), target_var.get("fields", [])):
                blockers.append({
                    "type": "type_mismatch",
                    "variant_name": name,
                    "target_fields": target_var.get("fields", []),
                    "current_fields": cur_var.get("fields", []),
                    "description": (
                        f"Variant '{name}' has different fields in current vs rollback target. "
                        "Rolling back would cause deserialization errors for existing keys."
                    ),
                })
        else:
            # Variant in target but NOT in current — this means current deleted it.
            # This is a blocker: current code has removed a variant that the rollback target uses.
            blockers.append({
                "type": "missing_in_current",
                "variant_name": name,
                "target_ordinal": target_var["ordinal"],
                "description": (
                    f"Variant '{name}' (ordinal {target_var['ordinal']}) exists in the rollback "
                    "target but is absent from the current snapshot. "
                    "The rollback target expects this key but current code cannot encode it."
                ),
            })

    # Check: variants present in current but absent in target
    for name, cur_var in current_by_name.items():
        if name not in target_by_name:
            # This key was added after the target version
            is_tombstone = cur_var.get("tombstone", False)
            if not is_tombstone:
                # Non-tombstone variant: rolling back re-exposes this ordinal
                warnings.append({
                    "type": "live_data_exposed",
                    "variant_name": name,
                    "current_ordinal": cur_var["ordinal"],
                    "description": (
                        f"Variant '{name}' (ordinal {cur_var['ordinal']}) was added in the "
                        "current version but is absent from the rollback target. "
                        "Live on-chain data written under this key by the current version "
                        "will be orphaned (the rollback target code cannot read or manage it). "
                        "Verify whether any data exists under this key before rolling back."
                    ),
                })
            # Tombstone variants added in current: no concern for rollback

    return blockers, warnings


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate rollback safety: check current → rollback-target compatibility."
    )
    parser.add_argument(
        "--current",
        required=True,
        help="Path to the current (deployed) snapshot JSON.",
    )
    parser.add_argument(
        "--rollback-target",
        required=True,
        help="Path to the snapshot you want to rollback to.",
    )
    parser.add_argument(
        "--report",
        default=None,
        help="Optional path to write the JSON rollback safety report.",
    )
    args = parser.parse_args()

    # Load snapshots
    try:
        current_snapshot = load_snapshot(args.current)
    except FileNotFoundError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"ERROR: Could not load current snapshot: {e}", file=sys.stderr)
        return 1

    try:
        target_snapshot = load_snapshot(args.rollback_target)
    except FileNotFoundError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"ERROR: Could not load rollback target snapshot: {e}", file=sys.stderr)
        return 1

    blockers, warnings = validate_rollback(current_snapshot, target_snapshot)
    safe = len(blockers) == 0

    report = {
        "safe": safe,
        "warnings": warnings,
        "blockers": blockers,
        "current_commit": current_snapshot.get("git_commit", "unknown"),
        "target_commit": target_snapshot.get("git_commit", "unknown"),
        "contract": current_snapshot.get("contract", "unknown"),
    }

    if args.report:
        report_path = Path(args.report)
        try:
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(f"Rollback report written to: {report_path}")
        except OSError as e:
            print(f"ERROR: Could not write report: {e}", file=sys.stderr)
            return 1

    # Human-readable summary
    print()
    print("═══════════════════════════════════════════")
    print("  Rollback Safety Report")
    print("═══════════════════════════════════════════")
    print(f"  Contract       : {report['contract']}")
    print(f"  Current        : {report['current_commit']}")
    print(f"  Rollback target: {report['target_commit']}")
    print(f"  Safe           : {'YES' if safe else 'NO'}")
    print()

    if blockers:
        print(f"  BLOCKERS ({len(blockers)}):")
        for b in blockers:
            print(f"    [{b['type']}] '{b['variant_name']}'")
            print(f"      {b['description']}")
        print()

    if warnings:
        print(f"  WARNINGS ({len(warnings)}):")
        for w in warnings:
            print(f"    [{w['type']}] '{w['variant_name']}' (ordinal={w.get('current_ordinal', '?')})")
            print(f"      {w['description']}")
        print()

    if safe:
        if warnings:
            print("  ⚠ Rollback is technically SAFE but has warnings — review before proceeding.")
        else:
            print("  ✓ Rollback is SAFE.")
    else:
        print("  ✗ Rollback has BLOCKERS — do NOT rollback without resolution.")
    print()

    return 0 if safe else 1


if __name__ == "__main__":
    sys.exit(main())
