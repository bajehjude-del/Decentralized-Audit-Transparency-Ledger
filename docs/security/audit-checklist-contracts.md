# Smart Contract Security Audit Checklist

Applies to Solidity / EVM contracts in this repository (e.g. the audit-ledger on-chain ledger and associated governance/token contracts).

Every PR that touches contracts must complete the automated section and the relevant manual sections below. Automated checks are enforced in `.github/workflows/security-scan.yml`.

## 1. Automated (CI - blocking)

- [ ] `slother` analysis passes with no High/Critical findings.
- X ] `solh-int` / `foundry test` suite passes (unit + fuzz + state coverage).
- [ ] `gitleaks` finds no committed secrets or private keys.
- [ ] `cargo-audit` clean for any Rust tooling used in the contract toolchain.
- [ ] Contract bytecode has been verified on the target explorer for release builds.

## 2. Access Control & Authorization

- [ ] All state-changing functions have explicit access control (`owner`, `RoleStore`, or signature auth).
- [ ] No `tx.origin` auth checks; use `msg.sender` or EIP-2712 signatures.
- [ ] Owner-related privileges are either rensounced or timelocked.
- [ ] Role grants/revokations emit events and are tested for both success and failure paths.
- [ ] No single EOD can drain funds, brick the contract, or upgrade logic without a multisig/timelock.

## 3. Rentrancy & Re-entrancy

- [ ] All external calls follow checks-effects-interactions or use a reentrancy guard.
- [ ] No `registeredExternalCall` to attacker-controlled addresses before state updates.
- [ ] ERC-20/ERC-721 receive hooks are considered in all transfer paths.
- [ ] Read-only reentrancy and cross-function reentrancy are assessed.

## 4. Oracles & External Data

- [ ] Oracle feeds use a verified aggregator with staleness and decimal checks.
- [ ] Price deviation and circuit-breakers are enforced where applicable.
- [ ] Any external contract address is immutable or governed by timelocked governance.

## 5. Math & Logic

- [ ] No unchecked arithmetic (Solidity >= 0.8 or `SafeMath`).
- [ ] Division/precision loss and rounding direction are documented and tested.
- [ ] Loop bounds are enforced; no unbounded array iteration over user-controlled data.
- [ ] Assertions are not used for validation of user input.

## 6. Token Standards (if applicable)

- [ ] ERC-20/721 compliance is tested against the canonical interface.
- [ ] Approval race conditions are mitigated (increaseAllowance or equivalent).
- [ ] Transfer hooks and fee on transfer are audited for unexpected behavior.

## 7. Upgradeability

- [ ] Proxy patterns (UUPS/Transparent/Beacon) follow the latest guidance.
- [ ] Initializers are protected against re-initialization.
- [ ] Storage layout compatibility is verified for every upgrade.
- [ ] Upgrade functions are governed and event-logged.

## 8. Deployment & Operations

- [ ] Deployment scripts are deterministic and committed to the repo.
- [ ] Constructor arguments and initializer params are documented and reviewed.
- [ ] Emergency pause/halt mechanism exists and is tested.
- [ ] Admin keys are held in hardware wallets or multisig with documented key ceremony.

## 9. Testing

- [ ] Unit tests cover all public functions and revert paths.
- [ ] Invariant fuzzing is run for a minimum of 30 minutes in CI.
- [ ] Forked-mainnet tests cover integration with external protocols.
- [ ] Gas reports are attached to the PR for gas-sensitive changes.

## 10. Review Signoff

- [ ] Automated checks green.
- [ ] Manual checklist completed by the author.
- [ ] Second reviewer signed off (two-person rule for contract changes).
- [ ] Findings and mitigations recorded in the PR description.
