# Contract Upgrade Checklist

This checklist is the operational companion to `docs/upgrade-guide.md`. It covers the full lifecycle of an upgrade: pre-upgrade validation, storage migration, rollback, testing, CI simulation, announcement, and post-upgrade verification.

The authoritative on-chain entry point is the `upgrade_contract` function (see `docs/upgrade-guide.md`, lines 1534-1552). Storage migrations are applied via `migrate_storage(caller: Address, migration_steps: Vec<MigrationStep>)`.

---

## 0. Prerequisites

- [] Adversarial review of the new WASM binary completed and signed off by at least two reviewers.
- [] Corresponding ADR added under `docs/adr/` for any storage layout or public API change.
- [] A governance proposal exists and has been shared with the community for the mandatory review window.
- [] The new contract version identifier is recorded (git tag, build hash, and WASM hash).
- [] Emergency contacts are confirmed active (see Section 6).

---

## 1. Storage Layout Compatibility Rules

Apply these rules to every change in the contract's persistent storage.

1. **Append-only fields.** New fields must be appended after existing fields. Never reorder, rename, or insert in the middle.
2. **Type stability.** A field's type must not change. Widening (e.g. `u32` -> `u64`) is a breaking change and requires a new field + migration step.
3. **No deletions.** Removed fields must be deprecated in place (keep the slot, stop writing to it) and only reclaimed in a later, explicitly announced major upgrade.
4. **Enum variant ordering.** Existing enum variants must keep their discriminant order. New variants are appended at the end.
5. **Map key stability.** Map key types must not change. Rekeying requires a migration step that reads the old key and writes the new one.
6. **Nested structs.** Nested structs follow the same append-only rule recursively. Adding a field to a nested struct is a breaking change for the outer struct.
7. **Storage keys.** Do not change the derivation of manually managed storage keys. Treat them as immutable once shipped.
8. **Initialization guards.** New fields added in an upgrade must be initialized by a migration step, not by a new `initialize` guard that would block existing state.

### 1.1 Layout Diff Checklist

- [] Export the old and new storage layout descriptors and diff them.
- [] Confirm every diff is either an append or is covered by an explicit `MigrationStep`.
- [] Confirm no field was reordered, removed, or retyped without a migration step.
- [] Attach the layout diff to the governance proposal and the ADR.

---

## 2. Pre-Upgrade Validation

All checks in this section must pass before the governance proposal is executed.

### 2.1 Storage Layout

- [] Run the layout diff tool and confirm the output matches the expected diff in the ADR.
- [] Confirm every added field has a corresponding `MigrationStep` in the proposed `migration_steps` vector.
- [] Confirm the migration is idempotent: running it twice on a snapshot produces the same state.
- [] Confirm the migration is restartable: an interrupted migration can be resumed without data loss.

### 2.2 Function Signatures

- [] Diff the public API against the previous release.
- [] Confirm no existing public function was removed or renamed.
- [] Confirm no existing public function changed its parameter order, types, or return type.
- [] Confirm new functions are additive and do not shadow existing names.
- [] Confirm authorization guards (admin/governance/owner) are unchanged or tightened.
- [] Confirm `upgrade_contract` itself is still guarded by the expected authority and has not been weakened.

### 2.3 Events

- [] Diff the event schema against the previous release.
- [] Confirm no existing event was removed or renamed.
- [] Confirm no existing event changed its field order or types.
- [] Confirm new events are additive.
- [] Confirm the upgrade itself emits a versioned upgrade event with the old and new version identifiers.
- [] Confirm the migration emits an event per applied `MigrationStep` for auditability.

### 2.4 Automated Validation Command

Run the pre-upgrade validator against the candidate binary and the current mainnet layout snapshot:

```
cargo run --pkg upgrade-tooling - validate \
  --old-layout layouts/mainnet.json \
  --new-layout layouts/candidate.json \
  --old-abi abi/mainnet.json \
  --new-abi abi/candidate.json \
  --migration migrations/candidate.json
```

The command fails non-zero if any of the following are detected:

- a storage field was reordered, removed, or retyped without a migration step,
- a public function signature changed incompatibly,
- an event signature changed incompatibly,
- a migration step references a non-existent field or a field with an incompatible type.

---

## 3. Migration Steps

Migrations are expressed as a vector of `MigrationStep` and applied by `migrate_storage(caller: Address, migration_steps: Vec<MigrationStep>)d.

### 3.1 Step Kinds

Each `MigrationStep` must be one of the following, and must be executed in the order given:

1. `AddField` - add a new storage field at the end of a struct with an explicit initial value.
2. `RenameField` - rename a field while preserving its slot and type.
3. `ConvertField` - convert a field's value from one type to another using a declared conversion.
4. `RekeyMap` - rekey a map from an old key type to a new key type.
5. `SetDefault` - set a default value for a field that may be uninitialized.

### 3.2 Migration Checklist

- [] Every added field has a matching `AddField` step with an explicit initial value.
- [] Every renamed field has a matching `RenameField` step.
- [] Every type change has a matching `ConvertField` step with a declared conversion.
- [] Every rekeyed map has a matching `RekeyMap` step.
- [] The migration vector is ordered so dependencies come before dependents.
- [] No step depends on a field that has not yet been added or converted.
- [] The migration has been run against a full mainnet state snapshot in a forked environment.
- [] The migration has been run against a full mainnet state snapshot with the migration interrupted midway and resumed.
- [] The migration has been run twice in a single environment to confirm idempotence.

---

## 4. Rollback Procedures

### 4.1 Rollback Triggers

Roll back immediately if any of the following occur:

- The migration fails or panics on mainnet.
- Any storage invariant is violated after migration.
- Any critical function returns an unexpected result or reverts.
- Observed gas costs exceed the budget by more than 50%.
- An exploit or unexpected authorization bypass is detected.

### 4.2 Rollback Procedure

1. Freeze all non-essential write paths via the emergency pause guard.
2. Snapshot the current storage state and attach it to the incident ticket.
3. Execute `upgrade_contract` with the previous known-good WASM hash.
4. Run the post-upgrade verification checklist (Section 8) against the rolled-back binary.
5. Confirm the rollback with the governance committee and publish a public incident note.
6. Open a post-mortem ticket within 24 hours of the rollback.

### 4.3 Rollback Preconditions

- [] The previous known-good WASM hash is recorded in the governance proposal.
- [] A full storage snapshot was taken immediately before the upgrade.
- [] The emergency pause guard is verified working on the candidate binary.
- [] A dry-run rollback has been executed on staging within the last 7 days.
- [] Rollback has been tested on testnet with the actual candidate binary.

### 4.4 Emergency Contacts

Maintain this list in the governance runbook and review it on every upgrade. Roles rather than individual names are listed here so the list does not stale.

| Role | Responsibility | Escalation |
| --- | --- | --- |
| On-call protocol engineer | First responder, confirms incident | Pager duty rotation |
| Governance lead | Authorizes rollback proposal | Governance communications channel |
| Security lead | Leads triage and exploit analysis | Security escalation channel |
| Release engineer | Executes the rollback transaction | Release coordination channel |
| Communications lead | Publishes public status updates | Public comms handle |

---

## 5. Testing Procedures

### 5.1 Testnet

- [] Deploy the candidate binary to testnet using the same governance flow as mainnet.
- [] Run the full migration against a testnet state snapshot that mirrors mainnet shape.
- [] Run the entire integration suite against the upgraded testnet deployment.
- [] Run the rollback procedure and confirm the previous binary still works.
- [] Observe the deployment for at least 48 hours before promoting to staging.

### 5.2 Staging

- [] Replay a production-shaped workload against the staging deployment.
- [] Verify all events emitted during the upgrade and migration match the expected schema.
- [] Confirm gas costs for the migration and for critical paths are within budget.
- [] Confirm monitoring and alerting are wired to the new binary's metrics.
- [] Run the rollback drill on staging within 7 days of the planned mainnet upgrade.

### 5.3 Mainnet Rehearsal

- [] Execute the governance proposal on a forked mainnet validator set.
- [] Confirm the forked execution produces the same state root as the staging execution.
- [] Confirm the forked execution produces the same event log.

---

## 6. CI Upgrade Simulation

The upgrade simulation job runs on every pull request that touches contract source, storage layouts, or migration definitions.

```yaml
name: upgrade-simulation
on:
  pull_request:
    paths:
      - 'contracts/**'
      - 'layouts/**'
      - 'migrations/**'
      - 'upgrade-tooling/**'
jobs:
  simulate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-rust@v1
        with:
          toolchain: stable
      - name: Build candidate binary
        run: cargo build --release --pkg contracts
      - name: Extract layout and ABI
        run: cargo run --pkg upgrade-tooling - extract --bin out/contract.wasm --out layouts/candidate.json --abi abi/candidate.json
      - name: Validate upgrade
        run: cargo run --pkg upgrade-tooling - validate --old-layout layouts/mainnet.json --new-layout layouts/candidate.json --old-abi abi/mainnet.json --new-abi abi/candidate.json --migration migrations/candidate.json
      - name: Simulate migration on mainnet snapshot
        run: cargo run --pkg upgrade-tooling - simulate --snapshot snapshots/mainnet.json --migration migrations/candidate.json --assert-invariants invariants/main.json
      - name: Simulate rollback
        run: cargo run --pkg upgrade-tooling - simulate-rollback --snapshot snapshots/mainner.json --previous-binary bin/previous.wasm
```

### 6.1 CI Checklist

- [] The job fails if the layout validator reports any incompatible change.
- [] The job fails if the migration simulation violates any declared invariant.
- [] The job fails if the rollback simulation does not restore the snapshot state root.
- [] The job attaches the layout diff, migration log, and rollback log as build artifacts.
- [] The job is required to pass before the governance proposal can be merged.

---

## 7. Upgrade Announcement Templates

### 7.1 Pre-Upgrade Announcement

```
Subject: Scheduled contract upgrade <tag> on <date>

We will upgrade the contract to <tag> on <date> at <time> <timezone>.

Summary of changes:
- Storage layout: <additive | breaking with migration>
- Public API: <additive | incompatible>
- Events: <additive | incompatible>
- Migration steps: <count> (<duration estimate>)

Governance proposal: <link>
ADR: <link>
Layout diff: <link>

Expected impact: <impact>
Expected downtime: <downtime or none>
Rollback plan: <rollback plan link>
Contact: <governance contact channel>

```

### 7.2 Upgrade Complete Announcement

```
Subject: Contract upgrade <tag> completed on <date>

The contract was upgraded to <tag> at <time> <timezone>.

Transaction: <link>
New WASM hash: <hash>
Migration transaction: <link>
Migration steps applied: <count>

Post-upgrade verification: <link to checklist run>

If you observe any anomaly, contact <governance contact channel>.

```

### 7.3 Rollback Announcement

```
Subject: Contract rollback to <previous tag> on <date>

We have rolled the contract back to <previous tag> at <time> <timezone>.

Reason: <reason>
Incident ticket: <link>
Rollback transaction: <link>
Restored WASM hash: <hash>

State integrity: <verified via post-upgrade checklist>
Post-mortem: <scheduled within 24 hours>

We apologize for the disruption and will publish a full post-mortem.

```

---

## 8. Post-Upgrade Verification Checklist

Run this immediately after the upgrade transaction confirms, and again after 24 hours.

### 8.1 Immediate (0 - 1 hour)

- [] Confirm the new WASM hash on chain matches the candidate hash.
- [] Confirm the version identifier returned by the contract matches the release tag.
- [] Confirm the upgrade event was emitted with the expected old and new versions.
- [] Confirm the migration transaction succeeded and emitted one event per step.
- [] Confirm all declared storage invariants hold on the live state.
- [] Confirm critical read functions return the expected values.
- [] Confirm the emergency pause guard is not active.

### 8.2 Short Term (1 - 24 hours)

- [] Monitor error rates and revert rates for all public functions.
- [] Monitor gas consumption on critical paths against the pre-upgrade baseline.
- [] Confirm no new alerts fired in monitoring.
- [] Confirm event ingestion pipelines are receiving the new events.
- [] Confirm downstream integrations are functioning against the new contract.

### 8.3 Long Term (24 hours - 7 days)

- [] Confirm no data corruption incidents were reported.
- [] Confirm no authorization anomalies were detected.
- [] Confirm the storage snapshot taken after the upgrade matches the expected shape.
- [] Close the upgrade ticket and attach the verification report.
- [] Update the governance runbook with any lessons learned.

---

## 9. Sign-Off

| Step | Owner | Signed off | Date |
| --- | --- | --- | --- |
| Pre-upgrade validation | Engineering | [] | |
| Storage layout review | Adversarial security | [] | |
| Migration simulation | Engineering | [] | |
| Rollback drill | Engineering | [] | |
| CI simulation | CI| [] | |
| Testnet deployment | Engineering | [] | |
| Staging deployment | Engineering | [] | |
| Governance proposal | Governance | [] | |
| Announcement published | Communications | [] | |
| Post-upgrade verification | Engineering | [] | |
