# Contract benchmark methodology

How the AuditLedger contract benchmarking suite measures performance, what its
numbers mean, and what the regression gate does and does not check. Issue
[#406](https://github.com/daddygokings-art/Decentralized-Audit-Transparency-Ledger/issues/406).

## Why a custom harness rather than `cargo bench`

`cargo bench`'s libtest harness answers "how many nanoseconds did this function
take on this machine". For a deployed contract that is close to the wrong
question. A user of this contract pays for **Soroban resources** — CPU
instructions, ledger entries read and written, bytes persisted, and the
resulting transaction fee — and those are metered by the protocol, not by the
host clock. Two runs on different hardware produce the same fee; two runs of the
same function with the same arguments produce the same resource numbers.

So the suite is a plain `fn main()` (`harness = false`) that drives the contract
through the Soroban host and reads the host's own invocation metering back out.
Determinism is the whole point: it is what allows a **5%** threshold to be a
meaningful gate rather than a coin flip.

## What is measured

Every case records two families of numbers.

### Resource metrics — deterministic, gated

Read from `Env::cost_estimate()` after the invocation, i.e. straight from the
Soroban host's own budget accounting:

| Metric | Meaning |
| --- | --- |
| `instructions` | Modelled CPU instructions. The dominant scaling term. |
| `fee_stroops` | Simulated transaction fee under the mainnet fee schedule. |
| `memory_read_entries` | In-memory ledger entries touched. |
| `disk_read_entries` | Ledger entries restored from disk. |
| `write_entries` | Ledger entries written. |
| `write_bytes` | Bytes persisted to the ledger. |
| `contract_events_size_bytes` | Volume of emitted contract events. |
| `mem_bytes` | Modelled contract memory footprint. |
| rent volumes | Persistent and temporary rent bumped, in ledger-bytes and bumps. |

These depend only on the scenario. They are the numbers the gate compares.

### Wall-clock metrics — noisy, advisory

`min` / `median` / `mean` / `max` nanoseconds per invocation, plus a `spread`
ratio `(max - min) / median` used as the suite's noise indicator.

**These are not gated by default.** They measure the machine that ran the
benchmark — a shared CI runner, a laptop on battery, a noisy neighbour — not the
contract. Gating on them would produce failures that have nothing to do with the
code under test. They are recorded because a case that becomes pathologically
slow is still worth noticing. Pass `--gate-wall-clock` to
`detect_regression.py` if you want them in the gate, and expect it to be
flaky.

### Artifact metrics

* **WASM size** — byte length of the built contract artifact, plus its SHA-256
  and the budget it is measured against. Because it is a build artifact rather
  than a timing, it is fully deterministic and *is* gated on growth.
* **Host peak RSS** — the high-water resident set size of the benchmark process.
  This is the one memory number that cannot be read in-process, because a process
  cannot report its own peak. `scripts/bench/run_benchmarks.sh` captures it with
  GNU `time -f '%M'`; on macOS (where BSD `time` has no such format and there is
  no `/proc`) the field is simply left empty rather than guessed.

## The measurement protocol

Per case, implemented in `bench/benches/support/measure.rs`:

1. Build a **fresh** `Env` and a freshly deployed contract. Fixture construction
   is *excluded* from every timing — otherwise deployment cost would be charged
   to the function under test.
2. Pre-build every invocation argument in the setup closure. Argument
   construction is setup, not measurement.
3. Run `warmup` untimed invocations (default 1) so first-call allocator and
   codec costs do not land in the sample.
4. Run `iterations` timed invocations (default 7), each against a fresh fixture.
5. Read the host metering after the last invocation. The host resets its budget
   before every top-level invocation, so the numbers describe exactly one call.

Only step 4 is timed, and only the invocation itself.

**Determinism is verified, not assumed.** Two independent runs of the same
commit produce byte-identical resource metrics across every case and every
resource field. If a future change breaks that property, the gate will start
producing false positives — which is why the CI job runs the whole suite rather
than a sampled subset.

### Normalisation

Most cases measure one invocation of one entry point. Cases that produce many
units — a batch of 50 events, a page of 30 results, a 25-event cleanup — are
reported both as a whole (`invocation`) and **per unit** (`event`, `page`):

```
per_unit.X = invocation.X / unit_count
```

`per_unit` is the headline comparison key. It is what makes "50 events in one
call" directly comparable to "1 event per call", and it is what exposes a batch
entry point that fails to amortise its fixed per-invocation cost.

**Ledger entry counts are the exception and are deliberately *not* divided.**
`write_entries`, `memory_read_entries`, `disk_read_entries` and the rent-bump
counts describe the invocation as a whole, not the amount of work it carried.
Dividing them is not merely lossy but inverted in meaning: a 5-event batch that
writes 2 entries becomes `2 / 5 == 0` under integer division, which reads as
"this call writes nothing" when the truth is "this call amortises its writes
across the batch". So those columns are reported **per invocation** and labelled
as such (`wr/inv`, `rd/inv` in the console table, `*_entries_per_invocation` in
the CSV). The volume metrics — instructions, fee, bytes, event volume, rent —
are divided, because they do scale with the work done.

The result is visible directly in the numbers: a single `log_event` costs
2,260,724 stroops, while a 20-event `log_events` batch costs 153,723 stroops
*per event* while still performing only 2 ledger writes for the whole call.


## Scenario coverage

`cargo bench -p audit-ledger-bench --list-suites` prints the groups. There are
199 cases across seven:

| Suite | Covers |
| --- | --- |
| `single_event` | The `log_event` write path: metadata size sweep, dedup hit vs `force`, hierarchy, nonce, signed events, TTL shadow copies, RBAC, schema validation, emission modes. |
| `batch` | `log_events` amortisation from 1 to 50 events, including sizes past the mainnet write-entry budget (measured with limit enforcement disabled, so the cost curve is still visible). |
| `queries` | Read paths: point lookups, range scans, pagination, filtering, aggregate statistics, and their scaling as the ledger grows. |
| `governance` | Owner and multi-sig administration: schema registry, RBAC, proposal lifecycle, webhooks, snapshots, version tagging and rollback. |
| `archive` | Archival and retrieval: compression modes, checksums, listing, purging, and snapshot verify. |
| `storage` | Storage shape: instance vs persistent, write- and read-path scaling at 2/5/10/25 events, integrity verification — the suite that answers "is any index making this O(n) per call?". |
| `limits` | Where the contract *stops accepting* a call: the largest accepted metadata payload, the global event cap boundary, and the cheapest authorisation rejection. |

`limits` deserves a note. Its rejection cases are declared `expect_panic`, and
the harness **fails the run if a rejection stops happening**. A limit case that
quietly starts succeeding means the recorded boundary is stale, and that is a
regression in the coverage itself, not a passing test.

## Running it

```bash
# Full run: builds the WASM, benchmarks, archives, checks for regressions
scripts/bench/run_benchmarks.sh

# Just measure, no gate (useful while iterating on a scenario)
scripts/bench/run_benchmarks.sh --baseline-only

# One group, more samples
BENCH_SUITES=batch BENCH_ITERATIONS=20 scripts/bench/run_benchmarks.sh

# Deliberately accept the current numbers as the new reference
scripts/bench/run_benchmarks.sh --update-baseline

# A single case, by substring
cargo bench -p audit-ledger-bench --bench contract_bench -- --filter log_event/meta
```

Harness flags, each with an environment-variable equivalent so CI can vary a run
without changing the case list:

| Flag | Env | Default |
| --- | --- | --- |
| `--iterations N` | `BENCH_ITERATIONS` | 7 |
| `--warmup N` | `BENCH_WARMUP` | 1 |
| `--filter SUBSTR` | `BENCH_FILTER` | all |
| `--suite NAME[,NAME]` | `BENCH_SUITES` | all |
| `--out-dir DIR` | `BENCH_OUT_DIR` | `benchmarks/results` |
| `--fail-fast` | `BENCH_FAIL_FAST` | off |
| `--list-suites` | — | — |

The harness has no libtest harness, so it exits `0` on success, `1` on a
measurement failure or a detected limit drift, and `2` on bad arguments.

### Outputs

| File | Purpose |
| --- | --- |
| `benchmark-report.json` | The canonical report. Versioned by `schema_version`; the regression tooling refuses to compare incompatible versions. |
| `benchmark-report.csv` | Flat per-case comparison keys, for a spreadsheet or a quick diff. |
| `benchmark-report.md` | Human-readable table; appended to the CI job summary. |
| `regression.md` | The pass/fail comparison against the baseline. |
| `regression-summary.json` | Machine-readable verdict, consumed by the Grafana dashboard. |
| `benchmark-metrics.prom` | Prometheus exposition for the dashboard. |

## Regression detection

`scripts/bench/detect_regression.py` compares the current report against
`benchmarks/baseline.json`.

**The default threshold is 5%**, from the issue's budget. A case's metric must
grow by more than 5% to fail. Changes in either direction beyond the threshold
are reported; only growth fails.

Compared per case, on the **per-unit** view:

`instructions`, `fee_stroops`, `memory_read_entries`, `write_entries`,
`write_bytes`, `disk_read_entries`, `contract_events_size_bytes` — plus WASM
artifact size at the report level.

Deliberate decisions:

* **The baseline never moves automatically.** A baseline that is rewritten
  whenever a run regresses cannot detect a regression. Promotion is always
  explicit: `--update-baseline` locally, or a manual `workflow_dispatch` on the
  CI workflow.
* **A missing case is a warning, not a failure.** If a case disappears, the suite
  reports it loudly — that case is no longer regression-checked, which is a hole
  in the coverage. But deleting a case is a legitimate thing to do, so it does
  not by itself fail the build.
* **A new case is informational.** It has nothing to compare against yet. It
  becomes comparable once it is promoted into the baseline.
* **Cases that errored or asserted a limit are skipped**, on both sides. They
  carry no comparable numbers, and comparing them would produce nonsense.
* **A metric that was free and now costs something** counts as a regression
  rather than dividing by zero.

Exit codes: `0` clean, `1` regression found, `2` the inputs could not be used.

## CI

`.github/workflows/contract-benchmarks.yml` runs on pull requests that touch
`src/`, `bench/`, `scripts/bench/`, `Cargo.toml`/`Cargo.lock` or the baseline,
and weekly on a schedule.

* The **Regression gate** job builds the WASM, runs the suite, and fails the PR
  on a regression. It appends the comparison table to the job summary and emits
  `::warning` annotations so a regression is visible inline on the diff.
* The **Historical snapshot** job (scheduled and manual runs only) commits a
  dated report into `benchmarks/history/`. It runs even when the gate fails,
  because the failing run is exactly the one you will want to compare against
  later.

Baseline promotion is a deliberate `workflow_dispatch` input, never automatic.

## Historical tracking and visualisation

Two layers, because they answer different questions:

1. **Committed snapshots** — `benchmarks/history/YYYY-MM-DD.json`, written by the
   weekly job. This is the durable record: "which release got slower?" is
   answerable from the repository itself, without a metrics backend.
2. **Prometheus/Grafana** — `scripts/bench/prometheus_exposition.py` converts a
   report to Prometheus text exposition, and `run_benchmarks.sh` can push it to a
   Pushgateway (`--pushgateway URL`). The dashboard is
   `monitoring/grafana/dashboards/contract-benchmarks.json`: a gate status tile,
   the most expensive entry points by instructions and fee, storage read/write
   traffic, the historical trend, and an explicitly-labelled advisory row for
   wall-clock.

Reconstructing the exposition from the committed history is one command, with no
metrics backend at all:

```bash
scripts/bench/prometheus_exposition.py --history benchmarks/history --print
```

## Known limitations

* **The WASM artifact currently exceeds the 128 KiB budget the `wasm-size` CI job
  enforces** — the contract builds at roughly 353 KiB. The suite reports this
  honestly (`within_limit: false`) rather than hiding it, and the regression gate
  keys on *growth* rather than on the absolute budget, so an already-over-budget
  artifact still gets tracked properly. Bringing the artifact under budget is a
  separate piece of work from measuring it; see
  [contract size reduction](#contract-size-reduction).
* **Wall-clock numbers are not comparable across machines.** They are only
  meaningful against another run of the same case on similar hardware, which is
  why they are advisory.
* **The fee schedule is a snapshot.** `fee_stroops` reflects the fee parameters
  compiled into the SDK version under test. A network fee-schedule change moves
  it without any contract change.
* **The suite measures one deployment configuration.** `initialize` is called
  with a 4 KiB metadata cap and a 100 000-event cap. Different caps change the
  costs; the `limits` suite exists to make the boundary explicit.
* **Rejections carry no cost.** A case that the contract refuses is not a data
  point about resource usage — it records which limit tripped, and nothing else.

<a id="contract-size-reduction"></a>
## Contract size reduction

The `AuditLedger` contract is built as a `cdylib`, and a Soroban WASM exposes a
single contract interface. The crate also contains several *standalone*
contracts (`contract_event_privacy`, `privacy_preserving_analytics`,
`data_governance`, `multi_tenant`), each with its own `#[contractimpl]`.

Compiling all of them into one WASM is both semantically wrong and the main
driver of the artifact's size. They are therefore gated behind cargo features
that are enabled for host test builds and opt-in for feature-gated builds:

```toml
[features]
contract-event-privacy = []
privacy-analytics      = []
data-governance        = []
multi-tenant           = []
```

That removed the invalid multi-contract artifact, but the remaining contract is
still over budget, so the next levers are: dropping unused dependencies from the
WASM build, `[profile.release]` tuning beyond `opt-level = "z"`, and splitting
the optional modules into genuinely separate packages. Until that is done, the
`wasm-size` job in `.github/workflows/test.yml` is expected to fail; the
benchmark suite's job here is to make the size measurable and to catch it
growing, not to hide the failure.

## Adding a case

1. Put it in the suite that matches its question, or add a suite if the question
   is new. Add the name to `SUITES` in `bench/benches/suites/mod.rs`.
2. Name it `group/thing` and keep the name **stable** — it is the regression key,
   and renaming a case silently drops its history.
3. Record a `notes` string saying *why* the case exists, not what it does.
4. Use `measure` when the operation takes an extra iteration argument, and
   `measure_call` otherwise.
5. Set `unit` to `event` or `page` when the invocation produces many units, so the
   per-unit view is meaningful.
6. If the case is asserting a *limit* rather than a cost, use `expect_panic` and
   a note naming the limit.
7. Run it, read the numbers, and only then decide whether it belongs in the
   baseline.
