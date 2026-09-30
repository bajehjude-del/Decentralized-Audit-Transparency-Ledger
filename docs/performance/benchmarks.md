# Benchmark Results

> This page collects benchmark results. The contract benchmarking suite that
> produces the measured numbers below is documented in
> [Benchmark Methodology](benchmark-methodology.md); to rerun it,
> `scripts/bench/run_benchmarks.sh`.

## Methodology

- Tests run in the Soroban test environment (not on a live network), driven
  through a custom harness that reads the host's own invocation metering
  (`bench/benches/`), so the resource numbers are deterministic.
- Gas/fee estimates are from Stellar's simulation infrastructure (the network
  fee schedule compiled into the SDK under test).
- The sections below are a snapshot taken from the suite's baseline report
  (`benchmarks/baseline.json`). Run-to-run numbers are on
  `benchmarks/history/`.
- The latency figures in the legacy tables are from local development
  deployments; they precede the deterministic harness and are kept for
  historical context only.

## Contract Benchmarks (measured)

Updated from `scripts/bench/run_benchmarks.sh` (`199 cases`, baseline generated
per commit; numbers below are current at this writing).

### Single-event vs batch cost (amortisation)

The batch entry point amortises its fixed per-call cost: twenty events logged in
one call cost less than **a third** of the fee of one event logged alone, while
the whole batch still performs only two ledger writes.

| Events per call | Fee per event (stroops) | Instructions per event | Ledger writes (per call) | Read entries (per call) |
|-----------------|-------------------------|------------------------|--------------------------|-------------------------|
| 1 (log_event)   | 2,260,724               | 485,469                | 2 | 3 |
| 5  (log_events) | 486,295                 | 377,912                | 2 | 3 |
| 10 (log_events) | 264,535                 | 425,459                | 2 | 3 |
| 20 (log_events) | 153,723                 | 547,120                | 2 | 3 |

*Fee per event falls 93% from 1 to 20 events; ledger writes stay flat.*

### Metadata size impact (single event)

| Metadata | Fee (stroops) | Instructions | Write entries | Write bytes |
|----------|---------------|--------------|---------------|-------------|
| 0 B      | 2,267,152     | 596,322      | 4 | 2,408 |
| 64 B     | 2,272,324     | 606,952      | 4 | 2,536 |
| 256 B    | 2,287,842     | 638,842      | 4 | 2,920 |
| 1 KB     | 2,349,910     | 766,402      | 4 | 4,456 |

*Metadata is the primary cost lever: +4% fee and +29% instructions from 0 B to
1 KB.*

### Limits

The contract's advertised size bound (4 KiB, exercised by the limits suite):

| Case | Outcome | Fee (stroops) |
|------|---------|---------------|
| Largest accepted metadata (4096 B) | accepted | 2,598,184 |
| 4097 B metadata | rejected (`MetadataTooLarge`) | n/a |
| Last event within cap | accepted | 2,273,909 |
| Event past the global cap | rejected (`GlobalMaxLogsReached`) | n/a |

## Legacy estimates (pre-harness)

Kept for continuity; superseded by the measured rows above and the
methodology document. **Gas** here is the old coarse unit and is not directly
comparable with the current stroops figures.

### Sequential Logging

| Events | Gas (Total) | Gas (Per Event) | Time |
|--------|-------------|-----------------|------|
| 1,000 | ~5,000,000 | ~5,000 | ~0.5s |
| 10,000 | ~50,000,000 | ~5,000 | ~5s |
| 100,000 | ~500,000,000 | ~5,000 | ~50s |

*Scales linearly with event count.*

### Multi-Type Logging

| Event Types | Events Per Type | Total Events | Gas (Total) |
|-------------|-----------------|--------------|-------------|
| 10 | 1,000 | 10,000 | ~50,000,000 |
| 50 | 1,000 | 50,000 | ~250,000,000 |
| 100 | 1,000 | 100,000 | ~500,000,000 |

*No significant overhead from event type diversity.*

### Metadata Size Impact

| Metadata Size | Gas Per Event | Storage Per Event | Notes |
|---------------|--------------|-------------------|-------|
| 10 B | ~5,000 | ~210 B | Baseline |
| 100 B | ~8,000 | ~300 B | ~60% gas increase |
| 1 KB | ~20,000 | ~1.2 KB | ~4x gas increase |

### Concurrent Submitters

| Submitters | Events Each | Total Events | Gas (Total) | Observations |
|------------|-------------|--------------|-------------|--------------|
| 10 | 1,000 | 10,000 | ~50,000,000 | No contention |
| 100 | 100 | 10,000 | ~50,000,000 | No contention |
| 1,000 | 10 | 10,000 | ~50,000,000 | No contention |

## REST API Benchmarks

| Endpoint | Concurrency | p50 | p95 | p99 | Max |
|----------|-------------|-----|-----|-----|-----|
| `/api/v1/events` | 10 | 45ms | 120ms | 300ms | 500ms |
| `/api/v1/events` | 50 | 80ms | 250ms | 600ms | 1.2s |
| `/api/v1/events` | 100 | 150ms | 500ms | 1.2s | 2.5s |

## GraphQL API Benchmarks

| Query | Concurrency | p50 | p95 | p99 |
|-------|-------------|-----|-----|-----|
| `{ events(first: 50) { ... } }` | 10 | 90ms | 200ms | 400ms |
| `{ eventStats { total count } }` | 10 | 40ms | 100ms | 200ms |

## Bridge Benchmarks

| Operation | Time (p50) | Time (p95) | Gas (EVM) |
|-----------|-----------|-----------|-----------|
| Proof construction | 2s | 5s | N/A |
| EVM submission | 30s | 60s | ~200,000 |
| EVM verification | 15s | 30s | ~100,000 |

## Summary

- Contract operations are **O(1)** for individual reads and writes
- Event logging scales **linearly** with event count
- Event **logging in one call** (batch) is dramatically cheaper per event than
  one at a time, with no extra ledger traffic
- Metadata size is the primary cost lever for contract operations
- REST and GraphQL APIs show acceptable latency up to 50 concurrent connections
- Bridge latency is dominated by EVM block times
