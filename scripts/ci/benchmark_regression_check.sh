#!/usr/bin/env bash
# Contract benchmark regression validator (#406, replacing #476 #480 #478 #477)
#
# The previous version of this script read a benchmark output file, printed that
# the metrics were within tolerance, and exited 0 — without ever comparing
# anything, at a 10% threshold. It could not fail. This version delegates to the
# benchmark suite, which does the comparison, and fails when a metric degrades
# past the threshold.
#
# Usage:
#   scripts/ci/benchmark_regression_check.sh [benchmark-results.json] [threshold-pct]
#
# The first argument is a result file written by `audit-ledger-bench run`. When it
# is absent the suite is run directly, so this script works as a standalone gate.
#
# Exit codes:
#   0  no regression past the threshold
#   1  a regression past the threshold was found
#   2  the results could not be read or parsed

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESULTS="${1:-}"

# Resolve to an absolute path before changing directory. A caller that passes a
# relative path gets it silently ignored further down — the file test then fails,
# the script measures a fresh run instead of checking the file it was handed, and
# the gate reports on the wrong thing without saying so.
if [ -n "$RESULTS" ]; then
  case "$RESULTS" in
    /*) ;;
    *) RESULTS="$PWD/$RESULTS" ;;
  esac
fi
THRESHOLD_PCT="${2:-5}"

case "$THRESHOLD_PCT" in
  ''|*[!0-9.]*)
    echo "error: threshold must be a number, got '${THRESHOLD_PCT}'" >&2
    exit 2
    ;;
esac

if [ -z "$THRESHOLD_PCT" ] || [ "$THRESHOLD_PCT" -le 0 ] 2>/dev/null; then
  echo "error: threshold must be greater than zero, got '${THRESHOLD_PCT}'" >&2
  exit 2
fi

BENCH_DIR="$ROOT/tools/contract-bench"

echo "Contract benchmark regression check (threshold ${THRESHOLD_PCT}%)"

if [ ! -d "$BENCH_DIR" ]; then
  echo "error: benchmark suite not found at $BENCH_DIR" >&2
  exit 2
fi

cd "$BENCH_DIR"

# No baseline on record means there is nothing to compare against. That is not a
# pass and not a failure: it is the state of a first run, and the caller is told
# so explicitly instead of being handed a green result.
if [ ! -f "data/baseline.json" ]; then
  echo "notice: no baseline on record (data/baseline.json)."
  echo "notice: the first run establishes it. Run 'audit-ledger-bench promote' to accept it."
  if [ -z "$RESULTS" ]; then
    cargo run --release --quiet --bin audit-ledger-bench -- run --threshold "$THRESHOLD_PCT" || true
  fi
  exit 0
fi

if [ -z "$RESULTS" ] || [ ! -f "$RESULTS" ]; then
  # Measure and compare in one step.
  cargo run --release --quiet --bin audit-ledger-bench -- run --threshold "$THRESHOLD_PCT"
  exit $?
fi

if [ ! -s "$RESULTS" ]; then
  # An empty results file is a broken pipeline, not a clean bill of health. The
  # old script treated this as a pass.
  echo "error: results file '$RESULTS' is empty" >&2
  exit 2
fi

echo "comparing '$RESULTS' against data/baseline.json"

# `compare` is the command that holds the comparison, and it is the one that
# writes annotations. This script used to grep the output of `report`, which
# renders a retained run and never compares anything, so the count was always
# zero and the FAIL branch below was unreachable: the gate could not fail.
#
# The exit code is taken from the command rather than recounted here, so there is
# one source of truth for the verdict.
set +e
cargo run --release --quiet --bin audit-ledger-bench -- compare "$RESULTS" --threshold "$THRESHOLD_PCT"
STATUS=$?
set -e

if [ "$STATUS" -eq 1 ]; then
  echo "FAIL: a metric regressed beyond ${THRESHOLD_PCT}%"
  exit 1
fi
if [ "$STATUS" -ne 0 ]; then
  echo "error: the comparison could not be completed (exit $STATUS)" >&2
  exit 2
fi

echo "PASS: no metric regressed beyond ${THRESHOLD_PCT}%"
exit 0
