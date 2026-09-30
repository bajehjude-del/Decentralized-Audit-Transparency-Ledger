# Contract Upgrade Guide

A step-by-step guide for upgrading AuditLedger contract logic and migrating event data safely without data loss.

---

## Upgrade Overview

### When upgrades are needed

- **Bug fixes** — incorrect hash chain computation, auth bypass, off-by-one in index tracking.
- **New features** — additional `DataKey` variants, new governance functions, schema extensions.
- **Dependency bumps** — Soroban SDK major version updates that change XDR encoding.

### Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Data loss | Permanent; events are immutable but storage keys can become unreachable | Backup all events off-chain before upgrading |
| Contract downtime | New WASM replaces the old one atomically; there is no swap/warmup period | Freeze logging before upgrade to prevent in-flight writes |
| Broken integrations | Callers using removed functions or changed argument order will fail | Notify integrators; version the API |
| Storage key collision | Old `DataKey` variants encoded differently than new ones silently corrupt reads | Keep tombstone variants in the enum; never reuse ordinals |

---

## Storage Layout Compatibility Rules

Soroban stores values keyed by the XDR-encoded form of a `DataKey` enum variant. The encoding is positional: the ordinal of a variant in the enum determines its on-chain key. Breaking these rules can silently corrupt reads or make existing data unreachable.

1. **Never reorder or remove existing variants.** Append new variants at the end of the enum only. Removing a variant shifts the ordinals of every variant after it.
2. **Keep tombstone variants.** If a key is retired, replace it with a tombstone variant that is never written to again. Do not reuse its ordinal for a new key.
3. **Never change the field order of a `#[contracttype]` struct used as a storage value.** XDR encodes struct fields in declaration order. Reordering fields changes the encoding and corrupts existing values. Add new fields at the end only.
4. **Add new mandatory fields with a default or via migration.** If a new field has no sensible default, write a migration function that backfills it before readers depend on it.
5. **Do not change the storage tier of an existing key.** Moving a key from `instance()` to `persistent()` or vice versa makes the old value unreachable.
6. *(Do not change the `ScoVal / `Symbol` shape of a key.** A `Tuple(Symbol("event"), U32))` and a `Tuple(Symbol("event"), U32))` key must keep the same arrity and types.

### Compatibility matrix

| Change | Compatible? | Notes |
|--------|-------------|-------|
| Append new `DataKey` variant at end | ✅ Yes | Old keys keep their ordinals |
| Add new field at end of a contracttype struct | ✅ Yes | XDR encodes in declaration order |
| Reorder existing enum variants | ❌ No | Corrupts every key after the change |
| Remove a variant without a tombstone | ❌ No | Shifts ordinals of subsequent variants |
| Rename a variant with the same ordinal | ✅ Yes* | *The name is not part of the encoding, but keep the old name as an alias for readability |
| Change a key's storage tier | ❌ No | Old value becomes unreachable |
| Change a key's XDR type (e.g. `u32` → `u64`) | ❌ No | Encoding differs; old values are unreadable |

---

## Pre-Upgrade Checklist

Complete every item before invoking the WASM upgrade.

- [ ] **Back up all event data off-chain.** Run the backup script:
  ```bash
  bash tools/backup/backup.sh
  # verifies integrity after download
  bash tools/backup/verify.sh
  ```
  Store the backup in at least two locations (e.g., S3 + local).

- [ ] **Record the pre-upgrade state snapshot:**
  ```bash
  soroban contract invoke --id $CONTRACT_ID --network testnet -- total_events
  soroban contract invoke --id $CONTRACT_ID --network testnet -- get_owner
  ```
  Save these values — you will compare them after the upgrade.

-  [ ] **Run the pre-upgrade validation tool** to catch storage layout, function signature, and event schema breaks:
  ```bash
  bash tools/upgrade/validate.sh \
    --old-wasm target/wasm32-unknown-unknown/release/audit_ledger.optimized.wasm \
    --new-wasm target/wasm32-unknown-unknown/release/audit_ledger.optimized.wasm
  ```
  The validator fails the build if any of the following are detected:
  - a `DataKey` variant was removed or reordered,
  - a public function signature changed in a non-additive way,
  - an `Event` field was reordered or a field was removed.

- [ ] **Notify all integrators** of the planned upgrade window, expected downtime, and any API changes. Allow at least 48 hours notice for production systems. Use the announcement template in `docs/upgrade-announcement.md`.

- [ ] **Freeze event logging** by setting `global_max_logs` to the current `total_events` value:
  ```bash
  TOTAL=$(soroban contract invoke --id $CONTRACT_ID --network testnet -- total_events)
  soroban contract invoke \
    --id $CONTRACT_ID --source $OWNER_KEY --network testnet \
    -- set_global_max_logs --caller $OWNER_ADDRESS --new_max "$TOTAL"
  ```
  From this point, `log_event` and `log_events` will return `GlobalMaxLogsReached` (2), preventing new writes during migration.

- [ ] **Test the new WASM on a forked or standalone network** before applying to testnet/mainnet. The GitHub Actions workflow runs tests automatically on every push.

- [ ] **Confirm rollback readiness.** The previous WASM hash must still be available on-chain (or re-uploadable). Record it in the upgrade ticket.

- [ ] **Confirm emergency contacts** are on call for the upgrade window. See the Rollback Plan section below.

---

## Wasm Upgrade

Soroban supports in-place WASM replacement via `env.deployer().update_current_contract_wasm()`. The contract address, storage, and state are preserved; only the executable code changes.

### Build the new WASM

```bash
cargo build --target wasm32-unknown-unknown --release
soroban contract optimize \
  --wasm target/wasm32-unknown-unknown/release/audit_ledger.wasm
# output: target/wasm32-unknown-unknown/release/audit_ledger.optimized.wasm
```

### Upload and verify the WASM hash

```bash
NEW_HASH=$(soroban contract install \
  --wasm target/wasm32-unknown-unknown/release/audit_ledger.optimized.wasm \
  --source $OWNER_KEY \
  --network testnet)
echo "New WASM hash: $NEW_HASH"
```

Record `$NEW_HASH` — you will pass it to the upgrade function.

### Invoke the upgrade

The `upgrade` governance function (owner only) calls `env.deployer().update_current_contract_wasm()` internally:

```bash
soroban contract invoke \
  --id $CONTRACT_ID --source $OWNER_KEY --network testnet \
  -- upgrade \
  --caller $OWNER_ADDRESS \
  --new_wasm_hash "$NEW_HASH"
```

The contract bytecode is replaced atomically in the same transaction. Existing storage is untouched.

---

## Data Migration

Most upgrades do not require data migration — if you only add new `DataKey` variants and do not rename or reorder existing ones, old data remains readable.

### When migration is required

- A storage key's XDR encoding changed (e.g., a `contracttype` struct field was reordered).
- A key was renamed or replaced (e.g., `GlobalMaxLogs` + `TotalEvents` → `Config`).
- A new mandatory field was added to `Event` with no default.

### Migration step model

The contract exposes a generic migration entrypoint:

```rust
pub fn migrate_storage(env: Env, caller: Address, migration_steps: Vec<MigrationStep>) {
    caller.require_auth();
    Self::require_owner(&env, &caller);
    for step in migration_steps.iter() {
        Self::apply_migration_step(&env, &step);
    }
}
```

Each `MigrationStep` is a declarative description of a single storage mutation. Supported kinds are:

| Kind | Purpose |
|------|--------|
| `CopyKey` | Copy a value from one `DataKey` to another |
| `RenameKey` | Copy then leave the old key as a tombstone |
| `SetDefault` | Write a default value if the key is absent |
| `RemoveKey` | Delete a key only after a verified copy exists |

Example — fold separate `GlobalMaxLogs` + `TotalEvents` into `Config`:

```rust
let steps = vec![
    &el,
    MigrationStep {
        kind: MigrationKind::CopyKey,
        from: DataKey::GlobalMaxLogs,
        to: DataKey::Config,
    },
    MigrationStep {
        kind: MigrationKind::SetDefault,
        from: DataKey::TotalEvents,
        to: DataKey::Config,
    },
];
Self::migrate_storage(&env, &caller, &steps);
```

After the WASM upgrade:

```bash
soroban contract invoke \
  --id $CONTRACT_ID --source $OWNER_KEY --network testnet \
  -- migrate_storage \
  --caller $OWNER_ADDRESS \
  --migration_steps '[
{"kind":"CopyKey","from":"GlobalMaxLogs","to":"Config"},{"kind":"SetDefault","from":"TotalEvents","to":"Config"}]'
```

### Migration script generator

For large or repetitive migrations, generate the call from a machine-readable layout diff:

```bash
bash tools/upgrade/generate-migration.sh \
  --old-layout docs/storage-layout-v1.json \
  --new-layout docs/storage-layout-v2.json \
  --out tools/upgrade/migration-v1-to-v2.sh
```

The generator emits a script that invokes `migrate_storage` with the correct `migration_steps` array and a matching rollback script. Commit both scripts alongside the upgrade PR.

### Verify event data integrity

Spot-check a sample of events to confirm the hash chain is intact:

```bash
# Check first event (genesis: prev_hash should be all zeros)
soroban contract invoke --id $CONTRACT_ID --network testnet \
  -- get_event_by_order --order_index 0

# Check last event
LAST=$(($soroban contract invoke --id $CONTRACT_ID --network testnet -- total_events) - 1))
soroban contract invoke --id $CONTRACT_ID --network testnet \
  -- get_event_by_order --order_index "$LAST"
soroban contract invoke --id $CONTRACT_ID --network testnet \
  -- verify_chain
```

---

## Post-Upgrade Verification

1. **Confirm total event count matches pre-upgrade snapshot:**
   ```bash
   soroban contract invoke --id $CONTRACT_ID --network testnet -- total_events
   # Must equal the value recorded in the pre-upgrade checklist
   ```

2. **Spot-check specific events** by their known IDs (saved in the off-chain backup):
   ```bash
   soroban contract invoke --id $CONTRACT_ID --network testnet \
     -- get_event --id <KNOWN_EVENT_ID>
   ```

3. **Verify ownership is intact:**
   ```bash
   soroban contract invoke --id $CONTRACT_ID --network testnet -- get_owner
   ```

4. **Verify the hash chain end-to-end:**
   ```bash
   soroban contract invoke --id $CONTRACT_ID --network testnet -- verify_chain
   ```

5. **Unfreeze logging** by restoring the desired `global_max_logs`:
   ```bash
   soroban contract invoke \
     --id $CONTRACT_ID --source $OWNER_KEY --network testnet \
     -- set_global_max_logs --caller $OWNER_ADDRESS --new_max 500000
   ```

6. **Run a smoke-test log event** to confirm writes work end-to-end:
   ```bash
   soroban contract invoke \
     --id $CONTRACT_ID --source $SUBMITTER_KEY --network testnet \
     -- log_event \
     --submitter $SUBMITTER_ADDRESS \
     --event_type smoke_test \
     --metadata "upgrade-verified"
   ```

---

## Rollback Plan

Soroban does not provide a built-in rollback; a rollback is another upgrade to the previous WASM hash.

### Prerequisites

- The previous WASM hash must still exist on-chain (it does until ledger garbage collection removes it — typically days to weeks). Upload it again if needed:
  ```bash
  PREV_HASH=$(soroban contract install \
    --wasm path/to/previous/audit_ledger.optimized.wasm \
    --source $OWNER_KEY \
    --network testnet)
  ```

- The rollback script generated by `tools/upgrade/generate-migration.sh` must be available and reviewed.

### Steps

1. **Freeze logging** (same as pre-upgrade step) to prevent writes during rollback.
2. **Run the rollback migration** to undo forward migration steps (copy new keys back to old ones, then leave the new keys as tombstones):
   ```bash
   bash tools/upgrade/migration-v2-to-v1.sh --contract-id $CONTRACT_ID --network testnet
   ```
3. **Upgrade back** to the previous WASM:
   ```bash
   soroban contract invoke \
     --id $CONTRACT_ID --source $OWNER_KEY --network testnet \
     -- upgrade \
     --caller $OWNER_ADDRESS \
     --new_wasm_hash "$PREV_HASH"
   ```
4. **If data migration ran**, undo it by invoking a `rollback_v2_to_v1` function (write this before upgrading — not after):
   - Restoring from the off-chain backup via `tools/backup/restore.sh` may be the only option if forward-migration is not reversible.
5. **Verify state** using the post-upgrade verification steps above.
6. **Unfreeze logging.**
7. **Notify integrators** of the rollback.

### Restoring from backup

If on-chain state is unrecoverable, redeploy a fresh contract and replay events from the off-chain backup:

```bash
# Deploy fresh contract
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/audit_ledger.optimized.wasm \
  --source $OWNER_KEY \
  --network testnet

# Initialize
soroban contract invoke --id $NEW_CONTRACT_ID --source $OWNER_KEY --network testnet \
  -- initialize --owner $OWNER_ADDRESS --global_max_logs 500000

# Replay from backup (adapt the restore script to call log_event per record)
bash tools/backup/restore.sh --contract-id $NEW_CONTRACT_ID
```

> **Warning:** Replayed events will have new timestamps and new IDs. External systems referencing old event IDs must be updated.

### Emergency contacts

| Role | Name | Contact | Escalation window |
|------|------|---------|------------------|
| Primary on-call engineer | ________ | Pager | Immediate |
| Contract owner | ________ | Pager + email | 15 minutes |
| Security lead | ________ | Pager + email | 30 minutes |
| Integrator liaison | ________ | Email | 4 hours |

Replace the placeholders above with the current on-call rotation before each upgrade.

---

## Upgrade Testing Procedures (Testnet & Staging)

1. **Local forked network.** Run the full upgrade against a fork of testnet state to catch migration bugs before touching any shared network.
2. **Testnet.** Apply the upgrade and migration on testnet and run the full post-upgrade verification checklist. Observe for at least 24 hours.
3. **Staging.** Apply the upgrade to a staging deployment that mirrors production configuration and integrations. Run integrator smoke tests against the staging endpoint.
4. **Mainnet.** Apply the upgrade during the announced window and run the post-upgrade verification checklist immediately.

---

## CI Integration for Upgrade Simulation

The repository includes a GitHub Actions workflow that simulates an upgrade on every push to a branch that touches the contract or the upgrade tooling:

```yaml
name: Upgrade Simulation

on:
  pull_request:
    paths:
      - "src/**"
      - "tools/upgrade/**"
      - "docs/upgrade-guide.md"

jobs:
  simulate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-rust@masterbanch
      - name: Build new WASM
        run: cargo build --target wasm32-unknown-unknown --release
      - name: Validate storage layout and API
        run: bash tools/upgrade/validate.sh --old-wasm $OLD_WASP --new-wasm target/wasm32-unknown-unknown/release/audit_ledger.wasm
        env:
          OLD_WASP: $ {{ secrets.OLD_WASM }}
      - name: Run upgrade simulation
        run: bash tools/upgrade/simulate.sh --new-wasm target/wasm32-unknown-unknown/release/audit_ledger.wasm
      - name: Upload simulation report
        uses: actions/upload-artifact@v4
        with:
          name: upgrade-simulation-report
          path: tools/upgrade/out/simulation-report.json
```

The simulation deploys the old WASM to an ephemeral network, seeds it with sample state, applies the new WASM and the generated migration script, and asserts that the post-upgrade state matches the expected layout.

---

## Upgrade Announcement Template

Send this to all integrators at least 48 hours before the upgrade window. A copy is maintained in `docs/upgrade-announcement.md`.

```markdown
Subject: [AuditLedger] Scheduled contract upgrade on <NETWORK> at <UTC>

Hello,

We will upgrade the AuditLedger contract on <NETWORK> at <UTC>.

- Contract ID: <CONTRACT_ID>
- New WASM hash: <NEW_HASH>
- Expected downtime: <DOWNTIME>
- API changes: <SUMMARY>
- Rollback window: <ROLLBACK_WINDOW>

Action required from integrators:
- Review the API changes above.
- Pause writes during the window if you can't tolerate retries.
- Report any anomalies to <EMERGENCY_CONTACT>.

Thanks,
<AuditLedger maintainers>
```

---

## Post-Upgrade Verification Checklist

- [ ] `total_events` matches the pre-upgrade snapshot.
-  [ ] `verify_chain` returns true.
-  [ ] get_owner` returns the expected owner address.
-  [ ] a sample of events from the off-chain backup returns the expected data.
-  [ ] `global_max_logs` is restored to the desired value.
-  [ ] a smoke-test `log_event` succeeds.
-  [ ] all integrators are notified that the upgrade is complete.
-  [ ] the upgrade ticket is updated with the new WASM hash, the migration script hash, and the verification evidence.
