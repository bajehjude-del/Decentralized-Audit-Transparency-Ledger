# Contract benchmark methodology

How `tools/contract-bench` produces its numbers, what those numbers do and do not
include, and what would have to change for them to become measurements of the
deployed contract.

## Summary

| | |
|---|---|
| Tool | `tools/contract-bench` (`audit-ledger-bench`) |
| Metric source | The Soroban host's own resource meter |
| Primary metric | Modelled CPU instructions |
| Secondary | Memory bytes, ledger entries read/written, bytes read/written, event bytes, rent bumps |
| Regression threshold | 5% |
| Determinism | Exact — two runs serialise byte-identically apart from the timestamp |
| Measures the contract's own instructions | **No** — see [Limitations](#limitations) |

## What is measured

Every figure is read back from the Soroban host after it has executed the work,
never estimated and never timed against a wall clock. Two host views are used:

- `Env::cost_estimate().budget()` for CPU instructions and memory bytes, reset
  before each workload.
- `Env::cost_estimate().resources()` for the resource totals the host computes
  per invocation, which is the only source of ledger-entry counts and byte
  volumes.

Each benchmark runs its workload as one contract invocation and reads the host's
meter for that invocation. The meter is per-invocation, so the figure needs no
arithmetic to isolate the workload: the fixture is excluded because it was a
different invocation, not because it was subtracted.

That distinction matters. Differencing two readings subtracts whichever frame ran
last from whichever ran before it, and the fixture's final frame is usually the
larger of the two — the difference then comes out *negative*. A measurement that
reports a negative cost for an append is worse than no measurement, and it is
exactly what the suite produced before this was corrected.

`src/measure.rs` holds this, and one of its tests fails if the host ever stops
reporting a counter — otherwise every number in the suite would silently become
zero and still pass.

### The suite's measurements

| Group | What it covers |
|---|---|
| `scenario` | The five required workflows: single event, batch events, queries, governance, archive |
| `storage` | Each host operation alone: instance and persistent writes, reads, presence checks, packed-index rewrite, rent extension, event emission |
| `function` | All 120 functions in `abi/audit-ledger.json`, each attributed to a measured cost profile |
| `wasm` | Module size by section, against a budget |

### Scenario coverage

Scenarios are measured at more than one ledger size because the contract's cost is
not constant in its size. `EventTypeIndices` and `SubmitterEventIndices` are packed
arrays of `u32` order indices that grow by four bytes per event and are **rewritten
in full on every append**, so an append's cost rises with the ledger behind it. The
suite measures that growth rather than assuming it away: an append costs about
1.76M instructions at 100 events and 4.26M at 300.

The sizes are bounded by the harness, and the bound is worth knowing about. A test
`Env` meters against the mainnet limits, and its 40 MiB memory budget covers the
whole environment — the SDK offers no way to widen it. Seeded events cost roughly
50 KB of metered memory each, so the largest fixture is `MAX_FIXTURE_EVENTS` (400).
Reads are measured there, because ledger size is the variable they are about.

Write paths are measured against smaller fixtures, `WRITE_LEDGER_SIZES` (100 and
300), and that asymmetry is itself the useful result: **a sixteen-event batch on a
300-event ledger already holds 33.7 MB of the network's 40 MiB per-invocation
memory.** Batch length, not ledger size, is what bounds a write on this contract.
Growing the fixture past 300 makes the batch unmeasurable, not because the batch
got more expensive but because the harness ran out of budget first.

So the ladder demonstrates how write and read cost scale with ledger size over the
range the harness can build, and the per-invocation figures it reports are what a
larger deployment would also pay per call. What it does not do is measure a
10 000-event ledger, and the documentation does not claim to.

## Limitations

Read this before quoting a number.

**The contract's own instructions are not measured.** The `audit-ledger` crate does
not compile — 417 errors against `soroban-sdk 27.0.6`, and its dev-dependency graph
does not resolve because `schema-registry-client = "0.12.0"` is not a published
version. Nothing can be linked against it, so it cannot be called, and its
arithmetic cannot be metered. The suite transcribes the contract's storage layout
and host operations from its source into `src/contract.rs` and measures those
operations in a real host.

**The consequence is a consistent bias, downwards.** The figures capture storage
traffic, event emission and rent extension. They exclude the contract's validation
logic, hashing, and any VM execution. Every reported cost is therefore a **lower
bound** on the deployed contract's real cost. A regression in the measured numbers
is real; an absence of regression is not proof of a cost that did not grow.

This bias is stated inside every result file, in the `model` field, so a number
cannot be quoted later without it.

**WASM size is currently unenforced.** Size needs a built artifact, and the
contract cannot be built. The analyzer works — it parses a real section table and
is tested against compiled modules — but `audit-ledger-bench wasm` reports
`NOT ENFORCED` rather than a passing result, and the CI step is explicitly
non-blocking. A budget that silently passed on a missing artifact would be worse
than no budget.

**Per-function figures are profile costs.** The 120 ABI functions are grouped into
eleven cost profiles, each measured once and attributed by function name and
mutability. The attribution is derived and printed in the report rather than
asserted, so a wrong mapping shows up as an implausible figure instead of passing
unnoticed. A per-function number is the cost of that function's storage behaviour,
not a profile of its instructions.

### Why the bias does not defeat the purpose

For a ledger contract the host operations dominate. One `log_event` writes six
records, extends rent on each, rewrites two index arrays and emits an event;
the surrounding validation is a handful of comparisons. The parts a change usually
makes worse — a new index, a larger stored struct, a missing rent extension, an
event that grew — are the parts this suite measures. What it will not catch is
regression in the contract's own compute, and it will not quantify the absolute
fee of a transaction.

## Why not wall-clock time

The issue asks for a 5% regression threshold. For timings that threshold would be
unusable: run-to-run variance on a shared CI runner routinely exceeds it, so the
gate would fail at random, get muted, and protect nothing.

The quantities compared here are metered by the host and are deterministic. The
suite's tests assert that two complete runs serialise byte-identically — not merely
that they compare equal, and with different timestamps, so that nondeterminism in
serialization order is caught as well. A 5% move is therefore a change in
behaviour rather than in the machine, which is what makes the threshold
meaningful.

A wall-clock measurement is still worth having for questions this suite cannot
answer — real transaction latency, RPC round trips, and how the deployed contract
performs on real hardware. `scripts/benchmark.sh` runs against testnet for that,
and its numbers are not comparable with anything here.

## Regression detection

A metric moving **up** is a regression, because every metric in the suite is a
cost. A metric moving **down** never fails the build: a suite that fails when the
contract gets cheaper is a suite that gets disabled. Direction is explicit per
metric rather than inferred.

Four cases are handled distinctly, because collapsing them into "equal" is how a
suite rots:

| Case | Treatment | Fails? |
|---|---|---|
| Metric up by more than 5% | Regression | **Yes** |
| Metric up by 5% or less | Within threshold | No |
| Metric down past the threshold | Improvement | No — but reported |
| Benchmark is new | Added | No — informational |
| Benchmark disappeared | Removed | No — coverage loss, reported |
| Result recorded no value (e.g. no WASM) | Unavailable | No — never compared against zero |
| Baseline is zero, now non-zero | Regression | **Yes** |

That last row matters. A percentage change from zero is undefined, and treating it
as neutral would let a benchmark start costing something without anyone noticing.
So zero-to-nonzero is a regression even though no percentage exists.

### The baseline is never updated automatically

`data/baseline.json` changes only when someone runs `audit-ledger-bench promote`.
Nothing in CI re-baselines after a run, and the weekly job only proposes it.

A suite that re-baselines itself cannot catch a slow regression: each run blesses
the previous one, and the numbers ratchet upward one sub-threshold step at a time,
permanently 4% below the alert threshold. Accepting a new cost is a decision a
person makes on purpose.

## History and visualisation

```
tools/contract-bench/data/
  baseline.json          the accepted reference
  history/<stamp>.json   every run, retained
```

Three renderings, all derived from the same data so they cannot disagree:

- **Markdown report** — for a reviewer in a CI log or a job summary.
- **SVG chart** — written as text with no dependencies, so history is visible in a
  pull request with no rendering toolchain. Byte-stable across runs for the same
  data, which is what lets a retained run be committed and diffed.
- **Prometheus exposition** — pushed to a Pushgateway when `GRAFANA_PUSH_URL` and
  `GRAFANA_PUSH_TOKEN` are set. The benchmark id becomes a label rather than part
  of the series name, so series stay joinable across runs.

`audit-ledger-bench dashboard --output dashboard.json` emits a Grafana dashboard
definition for those metrics: instruction cost per scenario, storage traffic,
metered memory, the WASM budget, and a per-function table by profile. It is a
separate command from `report` because it is a different artifact — one is read by
a person, the other is imported into Grafana.

## Running it

```bash
cd tools/contract-bench

cargo test                                     # 96 unit + 18 pipeline tests
cargo run --release --bin audit-ledger-bench -- run          # measure and compare
cargo run --release --bin audit-ledger-bench -- report       # Markdown report
cargo run --release --bin audit-ledger-bench -- compare FILE # gate a results file
cargo run --release --bin audit-ledger-bench -- dashboard   # Grafana dashboard JSON
cargo run --release --bin audit-ledger-bench -- history --ascii
cargo run --release --bin audit-ledger-bench -- wasm         # size and budget
cargo run --release --bin audit-ledger-bench -- export       # Prometheus text
cargo run --release --bin audit-ledger-bench -- promote      # accept as baseline

cargo bench --bench scenarios
cargo bench --bench functions
cargo bench --bench storage
```

`scripts/ci/benchmark_regression_check.sh` is the standalone gate. It previously
exited 0 without comparing anything, at a 10% threshold; it now delegates to the
suite at 5% and fails on a real regression.

## CI

`.github/workflows/contract-benchmarks.yml` runs on pull requests touching the
contract, the IDL or the suite, and weekly for drift nobody changed. It formats,
lints and tests the suite; measures; runs the three `cargo bench` targets; emits
GitHub annotations so a regression appears on the diff; uploads the JSON, the
chart and the metrics; and attempts a Grafana push when configured.

The job does not fail at the moment a regression is found. A regression is the one
result this workflow most needs to report on, so the report, the job summary and
the measurement artifacts are all still produced, and a final step fails the run
once the evidence has been collected. A red build with no explanation of what
changed is the outcome this ordering avoids.

The weekly schedule exists because a dependency or cost-model change arrives with
no diff for a reviewer to look at.

## Making this measure the real contract

In rough order of value:

1. **Make `audit-ledger` compile.** Fix the dev-dependency graph first:
   `schema-registry-client = "0.12.0"` is not a published version. Behind that
   sit the 417 contract errors, most likely a `soroban-sdk` version mismatch given
   the number of them.
2. **Move the integration-test dependencies behind a feature flag.** Every one of
   them — testcontainers, Kafka, Pulsar, Postgres, Redis — is a dev-dependency
   used by a handful of test files. A benchmark or unit-test run should not need
   to resolve them, and they are the reason the graph does not resolve at all.
3. **Call the contract from the harness.** With the contract compiling,
   `scenarios.rs` can invoke `AuditLedgerClient` instead of the operation model in
   `src/contract.rs`. The measurement code does not change — only the workload —
   so this is a contained change, and the `model` field in the result file is what
   records that the switch has been made.
4. **Measure on a network.** The SDK's own documentation notes that a native test
   contract under-reports against its WASM equivalent, because VM instantiation,
   module parsing and rent bumps on the module itself are not modelled. A
   `soroban contract invoke --simulate-only` sweep would close that gap, and
   `scripts/benchmark.sh` is the right shape for it.

Until step 3, treat every figure as a relative signal for the host operations the
contract performs — which is what the regression gate is for — and not as an
estimate of what a transaction will cost.
