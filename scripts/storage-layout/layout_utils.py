"""
layout_utils.py — Shared validation logic for storage layout comparison.

Imported by validate_layout.py, simulate_upgrade.py, and rollback_validate.py.
Uses only the Python standard library.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Data classes (plain dicts for simplicity — no dataclasses to preserve 3.9+)
# ---------------------------------------------------------------------------

class Violation:
    """Represents a breaking storage layout violation."""

    def __init__(self, rule: str, variant_name: str, ordinal: int, description: str):
        self.rule = rule
        self.variant_name = variant_name
        self.ordinal = ordinal
        self.description = description

    def to_dict(self) -> dict:
        return {
            "rule": self.rule,
            "variant_name": self.variant_name,
            "ordinal": self.ordinal,
            "description": self.description,
        }


class Warning:
    """Represents a non-breaking storage layout warning."""

    def __init__(self, rule: str, variant_name: str, ordinal: int, description: str):
        self.rule = rule
        self.variant_name = variant_name
        self.ordinal = ordinal
        self.description = description

    def to_dict(self) -> dict:
        return {
            "rule": self.rule,
            "variant_name": self.variant_name,
            "ordinal": self.ordinal,
            "description": self.description,
        }


# ---------------------------------------------------------------------------
# Snapshot loading
# ---------------------------------------------------------------------------

def load_snapshot(path: str | Path) -> dict:
    """Load and return a layout snapshot from a JSON file."""
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Snapshot not found: {p}")
    with p.open(encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Field comparison helpers
# ---------------------------------------------------------------------------

def fields_equal(a: list[dict], b: list[dict]) -> bool:
    """Return True if two field lists are structurally identical."""
    if len(a) != len(b):
        return False
    for fa, fb in zip(a, b):
        if fa.get("position") != fb.get("position"):
            return False
        if fa.get("type") != fb.get("type"):
            return False
        if fa.get("name") != fb.get("name"):
            return False
    return True


# ---------------------------------------------------------------------------
# Core validation logic
# ---------------------------------------------------------------------------

def validate_snapshots(
    old_snapshot: dict,
    new_snapshot: dict,
    allow_tombstone_removal: bool = False,
) -> tuple[list[Violation], list[Warning]]:
    """
    Compare two layout snapshots and return (violations, warnings).

    Rules enforced:
    1. No ordinal reuse — same ordinal must keep same name.
    2. No type changes — existing variant fields must be identical.
    3. Append-only — new variants added only at higher ordinals.
    4. Enum variant order preserved — relative order of existing variants unchanged.
    5. No silent tombstone removal — unless --allow-tombstone-removal.
    6. Non-tombstone removal is always BREAKING.
    """
    violations: list[Violation] = []
    warnings: list[Warning] = []

    old_variants: list[dict] = old_snapshot.get("variants", [])
    new_variants: list[dict] = new_snapshot.get("variants", [])

    # Build lookup maps
    old_by_ordinal: dict[int, dict] = {v["ordinal"]: v for v in old_variants}
    new_by_ordinal: dict[int, dict] = {v["ordinal"]: v for v in new_variants}
    old_by_name: dict[str, dict] = {v["name"]: v for v in old_variants}
    new_by_name: dict[str, dict] = {v["name"]: v for v in new_variants}

    # ── Rule 1: No ordinal reuse ──────────────────────────────────────────────
    for ordinal, old_var in old_by_ordinal.items():
        if ordinal in new_by_ordinal:
            new_var = new_by_ordinal[ordinal]
            if new_var["name"] != old_var["name"]:
                violations.append(Violation(
                    rule="no_ordinal_reuse",
                    variant_name=new_var["name"],
                    ordinal=ordinal,
                    description=(
                        f"Ordinal {ordinal} was '{old_var['name']}' but is now '{new_var['name']}'. "
                        "Reusing ordinals for different variants corrupts existing on-chain keys."
                    ),
                ))

    # ── Rule 2: No type changes ───────────────────────────────────────────────
    for name, old_var in old_by_name.items():
        if name in new_by_name:
            new_var = new_by_name[name]
            if not fields_equal(old_var.get("fields", []), new_var.get("fields", [])):
                violations.append(Violation(
                    rule="no_type_change",
                    variant_name=name,
                    ordinal=old_var["ordinal"],
                    description=(
                        f"Variant '{name}' (ordinal {old_var['ordinal']}) changed field layout. "
                        f"Old fields: {old_var.get('fields', [])} → "
                        f"New fields: {new_var.get('fields', [])}."
                    ),
                ))

    # ── Rule 3 & 4: Append-only and order preserved ───────────────────────────
    # Collect old variant names in order and find their positions in new snapshot.
    old_names_in_order = [v["name"] for v in sorted(old_variants, key=lambda x: x["ordinal"])]
    new_names_in_order = [v["name"] for v in sorted(new_variants, key=lambda x: x["ordinal"])]

    # Check that existing old names appear in the same relative order in new
    # Filter new_names_in_order to only names that existed in old
    new_existing_in_order = [n for n in new_names_in_order if n in old_by_name]

    if new_existing_in_order != [n for n in old_names_in_order if n in new_by_name]:
        # Find specific reordering violations
        violations.append(Violation(
            rule="order_preserved",
            variant_name="(multiple)",
            ordinal=-1,
            description=(
                "Relative order of existing variants has changed. "
                "This shifts XDR discriminant values and breaks deserialization of existing keys."
            ),
        ))

    # Check that new variants are only appended at the end (higher ordinals)
    max_old_ordinal = max((v["ordinal"] for v in old_variants), default=-1)
    for new_var in new_variants:
        name = new_var["name"]
        if name not in old_by_name:
            # This is a genuinely new variant — check its ordinal is > max_old_ordinal
            if new_var["ordinal"] <= max_old_ordinal:
                violations.append(Violation(
                    rule="append_only",
                    variant_name=name,
                    ordinal=new_var["ordinal"],
                    description=(
                        f"New variant '{name}' inserted at ordinal {new_var['ordinal']} "
                        f"which is <= max existing ordinal {max_old_ordinal}. "
                        "Inserting variants between existing ones shifts ordinals."
                    ),
                ))

    # ── Rule 5 & 6: Variant removal ───────────────────────────────────────────
    for name, old_var in old_by_name.items():
        if name not in new_by_name:
            if old_var.get("tombstone", False):
                if not allow_tombstone_removal:
                    warnings.append(Warning(
                        rule="tombstone_removal",
                        variant_name=name,
                        ordinal=old_var["ordinal"],
                        description=(
                            f"Tombstone variant '{name}' (ordinal {old_var['ordinal']}) "
                            "has been removed. Old data under this key may still exist on-chain. "
                            "Use --allow-tombstone-removal to suppress this warning."
                        ),
                    ))
            else:
                violations.append(Violation(
                    rule="no_removal",
                    variant_name=name,
                    ordinal=old_var["ordinal"],
                    description=(
                        f"Active (non-tombstone) variant '{name}' (ordinal {old_var['ordinal']}) "
                        "has been removed. Live on-chain data may exist under this key and will "
                        "become inaccessible."
                    ),
                ))

    return violations, warnings


# ---------------------------------------------------------------------------
# Stats helper
# ---------------------------------------------------------------------------

def compute_stats(old_snapshot: dict, new_snapshot: dict) -> dict:
    """Return comparison statistics between two snapshots."""
    old_names = {v["name"] for v in old_snapshot.get("variants", [])}
    new_names = {v["name"] for v in new_snapshot.get("variants", [])}
    old_by_name = {v["name"]: v for v in old_snapshot.get("variants", [])}
    new_by_name = {v["name"]: v for v in new_snapshot.get("variants", [])}

    added = new_names - old_names
    removed = old_names - new_names
    common = old_names & new_names

    changed = sum(
        1 for name in common
        if not fields_equal(
            old_by_name[name].get("fields", []),
            new_by_name[name].get("fields", []),
        )
    )

    return {
        "added": len(added),
        "removed": len(removed),
        "changed": changed,
        "total_old": len(old_snapshot.get("variants", [])),
        "total_new": len(new_snapshot.get("variants", [])),
    }
