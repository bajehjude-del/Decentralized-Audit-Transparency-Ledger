#!/usr/bin/env bash
#
# scripts/bench/run_benchmarks.sh
#
# One-shot entry point for the AuditLedger contract benchmarking suite (#406).
#
#   1. build the contract WASM (so the size/hash dimensions are populated)
#   2. run the Rust harness under `/usr/bin/time` to capture peak host RSS
#   3. feed the host numbers back into the report
#   4. archive a dated snapshot for historical tracking
#   5. run regression detection against the committed baseline
#   6. emit a Prometheus exposition file for the Grafana dashboard
#
# Usage:
#   scripts/bench/run_benchmarks.sh [--baseline-only] [--update-baseline]
#                                   [--threshold N] [--skip-wasm] [--no-gate]
#                                   [--pushgateway URL] [--history]
#
# Exit codes:
#   0  no regression
#   1  regression detected (or the harness itself failed)
#   2  the run could not be completed (bad arguments, missing baseline)
#
# Environment:
#   BENCH_ITERATIONS   timed invocations per case (default 7)
#   BENCH_WARMUP       untimed invocations per case (default 1)
#   BENCH_SUITES       comma-separated suite allow-list (default: all)
#   BENCH_FILTER       substring filter over `suite/name`

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BASELINE="benchmarks/baseline.json"
HISTORY_DIR="benchmarks/history"
RESULTS_DIR="benchmarks/results"
REPORT="$RESULTS_DIR/benchmark-report.json"
WASM_TARGET="wasm32v1-none"
WASM_FILE="target/$WASM_TARGET/release/audit_ledger.wasm"
DETECTOR="scripts/bench/detect_regression.py"
PROMETHEUS_EXPORT="scripts/bench/prometheus_exposition.py"

THRESHOLD=5
RUN_DETECTION=1
UPDATE_BASELINE=0
SKIP_WASM=0
PUSHGATEWAY_URL="${PUSHGATEWAY_URL:-}"
ARCHIVE_HISTORY=0

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 2; }

usage() {
    sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --baseline-only)    RUN_DETECTION=0 ;;
        --update-baseline)  UPDATE_BASELINE=1 ;;
        --threshold)        THRESHOLD="${2:?--threshold needs a value}"; shift ;;
        --skip-wasm)        SKIP_WASM=1 ;;
        --no-gate)          RUN_DETECTION=0 ;;
        --pushgateway)      PUSHGATEWAY_URL="${2:?--pushgateway needs a URL}"; shift ;;
        --history)          ARCHIVE_HISTORY=1 ;;
        -h|--help)          usage ;;
        *)                  die "unknown argument: $1 (see --help)" ;;
    esac
    shift
done

command -v cargo >/dev/null 2>&1 || die "cargo is not on PATH"
[[ -f "$DETECTOR" ]] || die "missing $DETECTOR"

mkdir -p "$RESULTS_DIR" "$HISTORY_DIR"

# ── 1. Contract WASM ────────────────────────────────────────────────────────
# Built first so the harness can record the artifact's size and SHA-256, and so
# the release job measures the same artifact it ships.
if [[ "$SKIP_WASM" -eq 0 ]]; then
    if ! rustup target list --installed 2>/dev/null | grep -qx "$WASM_TARGET"; then
        log "adding Rust target $WASM_TARGET"
        rustup target add "$WASM_TARGET" >/dev/null
    fi
    log "building contract WASM ($WASM_TARGET)"
    cargo build --target "$WASM_TARGET" --release
    [[ -f "$WASM_FILE" ]] || die "WASM artifact missing after build: $WASM_FILE"
    log "WASM: $(wc -c <"$WASM_FILE" | tr -d ' ') bytes"
else
    warn "skipping the WASM build; size and hash dimensions will be empty"
fi

# ── 2. Harness run, under /usr/bin/time for peak RSS ────────────────────────
log "running the benchmark harness"
BENCH_ARGS=(--out-dir "$RESULTS_DIR")
if [[ -n "${BENCH_SUITES:-}" ]]; then BENCH_ARGS+=(--suite "$BENCH_SUITES"); fi
if [[ -n "${BENCH_FILTER:-}" ]]; then BENCH_ARGS+=(--filter "$BENCH_FILTER"); fi
if [[ -n "${BENCH_ITERATIONS:-}" ]]; then BENCH_ARGS+=(--iterations "$BENCH_ITERATIONS"); fi
if [[ -n "${BENCH_WARMUP:-}" ]]; then BENCH_ARGS+=(--warmup "$BENCH_WARMUP"); fi

# Peak RSS is the process's high-water mark: it answers "how much memory does
# measuring this contract need", which no in-process counter can report. GNU
# time exposes it as %M (KiB); the BSD `time` shipped with macOS does not, and
# neither does `/proc`, so on macOS the harness simply reports nothing.
# `BENCH_REPORT_RSS=1` forces the external measurement off for local runs.
TIME_FILE="$RESULTS_DIR/.bench-rss.txt"
TIME_CMD=()
if [[ "${BENCH_REPORT_RSS:-1}" != "0" ]]; then
    if command -v gtime >/dev/null 2>&1; then
        TIME_CMD=(gtime -f '%M' -o "$TIME_FILE")
    elif /usr/bin/time -f '' true >/dev/null 2>&1; then
        # Probing for GNU `-f` support: macOS' BSD time fails here.
        TIME_CMD=(/usr/bin/time -f '%M' -o "$TIME_FILE")
    fi
fi
if [[ "${#TIME_CMD[@]}" -eq 0 ]]; then
    warn "no GNU time available; host peak-RSS will come from the harness only"
fi

HARNESS=(cargo bench -p audit-ledger-bench --bench contract_bench -- "${BENCH_ARGS[@]}")

set +e
# `TIME_CMD` may legitimately be empty, and bash 3.2 (still the system bash on
# macOS) treats expanding an empty array under `set -u` as an error, so the two
# invocations are kept explicit.
if [[ "${#TIME_CMD[@]}" -gt 0 ]]; then
    "${TIME_CMD[@]}" "${HARNESS[@]}" 2>&1 | sed 's/^/  /'
else
    "${HARNESS[@]}" 2>&1 | sed 's/^/  /'
fi
BENCH_STATUS="${PIPESTATUS[0]}"
set -e

if [[ ! -f "$REPORT" ]]; then
    die "the benchmark harness failed and produced no report (exit $BENCH_STATUS)"
fi

# ── 3. Fold the host measurements into the report ───────────────────────────
PEAK_RSS_KB=""
if [[ -f "$TIME_FILE" ]]; then
    PEAK_RSS_KB="$(tr -dc '0-9' <"$TIME_FILE" || true)"
fi
if [[ -n "$PEAK_RSS_KB" && "$PEAK_RSS_KB" != "0" ]]; then
    log "peak host RSS: $((PEAK_RSS_KB / 1024)) MiB"
    python3 - "$REPORT" "$PEAK_RSS_KB" <<'PY'
import json, sys
path, kib = sys.argv[1], int(sys.argv[2])
with open(path, encoding="utf-8") as handle:
    report = json.load(handle)
report.setdefault("host", {})["peak_rss_bytes"] = kib * 1024
with open(path, "w", encoding="utf-8") as handle:
    json.dump(report, handle, indent=2)
    handle.write("\n")
PY
else
    warn "peak host RSS unavailable on this platform"
fi

# A non-zero harness status means at least one case failed to measure. Detect it
# from the report rather than trusting the exit code alone, so the reason is
# always surfaced.
FAILED=$(python3 -c "
import json
report = json.load(open('$REPORT'))
print(sum(1 for case in report['cases'] if case.get('error')))" 2>/dev/null || echo 0)
if [[ "${FAILED:-0}" -gt 0 ]]; then
    warn "$FAILED benchmark case(s) failed to measure:"
    python3 -c "
import json
report = json.load(open('$REPORT'))
for case in report['cases']:
    if case.get('error'):
        print('  -', case['suite'] + '/' + case['name'] + ':', case['error'], file=__import__('sys').stderr)"
    die "benchmark measurement failures — see $REPORT"
fi

# ── 4. Historical snapshot ──────────────────────────────────────────────────
# Dated, committed snapshots are what make the trend view in Grafana and the
# "which release got slower" question answerable after the fact.
if [[ "$ARCHIVE_HISTORY" -eq 1 ]]; then
    STAMP="$(python3 -c "import json;print(json.load(open('$REPORT'))['generated_at'][:10])")"
    SNAPSHOT="$HISTORY_DIR/$STAMP.json"
    cp "$REPORT" "$SNAPSHOT"
    log "history snapshot: $SNAPSHOT"
fi

# ── 5. Regression detection ─────────────────────────────────────────────────
if [[ "$RUN_DETECTION" -eq 0 ]]; then
    log "regression detection skipped (--baseline-only/--no-gate)"
    exit 0
fi

[[ -f "$BASELINE" ]] || die "no baseline at $BASELINE; create one with --update-baseline"

if [[ "$UPDATE_BASELINE" -eq 1 ]]; then
    log "promoting the current run to the baseline"
    python3 "$DETECTOR" --baseline "$BASELINE" --current "$REPORT" --update-baseline
    exit 0
fi

log "checking for regressions beyond ${THRESHOLD}%"
DETECT_ARGS=(--baseline "$BASELINE" --current "$REPORT" --threshold "$THRESHOLD"
             --markdown-out "$RESULTS_DIR/regression.md"
             --summary-out "$RESULTS_DIR/regression-summary.json")
[[ -n "${GITHUB_ACTIONS:-}" ]] && DETECT_ARGS+=(--github-annotations)
set +e
python3 "$DETECTOR" "${DETECT_ARGS[@]}"
DETECT_STATUS=$?
set -e

# ── 6. Prometheus exposition, for the Grafana dashboard ─────────────────────
if [[ -f "$PROMETHEUS_EXPORT" ]]; then
    EXPORT_ARGS=(--out "$RESULTS_DIR/benchmark-metrics.prom")
    # The report always exists here; the summary only after a detection run.
    EXPORT_ARGS+=(--report "$REPORT")
    [[ -f "$RESULTS_DIR/regression-summary.json" ]] && \
        EXPORT_ARGS+=(--regressions "$RESULTS_DIR/regression-summary.json")
    if python3 "$PROMETHEUS_EXPORT" "${EXPORT_ARGS[@]}" >/dev/null 2>&1; then
        log "prometheus exposition: $RESULTS_DIR/benchmark-metrics.prom"
    else
        warn "could not build the Prometheus exposition file"
    fi
    if [[ -n "$PUSHGATEWAY_URL" ]]; then
        if curl -fsS --data-binary "@$RESULTS_DIR/benchmark-metrics.prom" \
                "$PUSHGATEWAY_URL/metrics/job/audit_ledger_bench" >/dev/null; then
            log "pushed metrics to $PUSHGATEWAY_URL"
        else
            warn "pushgateway push failed: $PUSHGATEWAY_URL"
        fi
    fi
fi

log "summary written to $RESULTS_DIR/regression.md"
exit "$DETECT_STATUS"
