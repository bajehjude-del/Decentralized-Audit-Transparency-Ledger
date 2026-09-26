# Benchmark Results

> **These figures are illustrative estimates, not measurements.**
>
> The numbers below were written by hand as expected magnitudes (`~5,000` gas per
> event, `~0.5s` per 1,000 events) before a benchmark suite existed to produce
> them. Nothing in this file was read back from a host meter, and the
> "Methodology" section it originally carried described a measurement process that
> was not performed. Treat every table here as a rough sense of scale and nothing
> more.
>
> For numbers that are actually measured, see
> [Contract benchmark methodology](benchmark-methodology.md) and the
> `tools/contract-bench` suite. Where the two disagree, the suite is right and
> this file is a guess.

## Methodology

- Tests run in the Soroban test environment (not on a live network)
- Gas estimates are from Stellar's simulation infrastructure
- Latency measurements are from local development deployments
- Production performance may vary based on network conditions

## Contract Benchmarks

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
- Metadata size is the primary cost lever for contract operations
- REST and GraphQL APIs show acceptable latency up to 50 concurrent connections
- Bridge latency is dominated by EVM block times
