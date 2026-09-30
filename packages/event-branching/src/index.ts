/**
 * @audit-ledger/event-branching
 *
 * Git-style collaborative workflows for contract events: branch creation,
 * three-way merge with conflict detection and resolution, and a role based
 * permission model with protected branches. Issue #429.
 */

export * from "./types.ts";
export * from "./permissions.ts";
export * from "./merge.ts";
export * from "./branching.ts";
