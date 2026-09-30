/**
 * Branch permissions (#429)
 *
 * A small role hierarchy, deliberately simple: each role is the union of every
 * capability below it, and a branch's role table is keyed by principal with `*`
 * standing for "everyone". Protected branches add a second gate on top of the
 * role, so holding `admin` is still not enough to bypass protection.
 */

import { BranchError } from "./types.ts";
import type { Actor, Branch, BranchAction, BranchRole } from "./types.ts";

const ROLE_CAPABILITIES: Record<BranchRole, BranchAction[]> = {
  none: ["read"],
  read: ["read"],
  write: ["read", "create-branch", "commit"],
  maintain: [
    "read",
    "create-branch",
    "commit",
    "delete-branch",
    "merge",
    "resolve",
    "force-update",
  ],
  admin: [
    "read",
    "create-branch",
    "commit",
    "delete-branch",
    "merge",
    "resolve",
    "protect",
    "unprotect",
    "force-update",
  ],
};

/** Capabilities granted to a role, lowest capability first. */
export function capabilitiesFor(role: BranchRole): BranchAction[] {
  return [...ROLE_CAPABILITIES[role]];
}

const ROLE_ORDER: BranchRole[] = ["none", "read", "write", "maintain", "admin"];

/** True when a role is at least as powerful as `minimum`. */
export function roleAtLeast(role: BranchRole, minimum: BranchRole): boolean {
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(minimum);
}

/** True when a role grants an action. */
export function roleCan(role: BranchRole, action: BranchAction): boolean {
  return ROLE_CAPABILITIES[role].includes(action);
}

/** Minimum role that grants an action. */
export function minimumRole(action: BranchAction): BranchRole {
  return ROLE_ORDER.find((role) => ROLE_CAPABILITIES[role].includes(action)) ?? "admin";
}

export type RoleTable = Map<string, Map<string, BranchRole>>;

/**
 * Resolves a principal's role, preferring a branch specific grant, then a
 * repository wide grant, then a wildcard default. `*` in the principal position
 * is the default for everyone.
 */
export function resolveRole(roles: RoleTable, branch: string, actor: Actor): BranchRole {
  if (actor.role) return actor.role;
  const branchTable = roles.get(branch);
  const specific = branchTable?.get(actor.id);
  if (specific) return specific;
  const branchDefault = branchTable?.get("*");
  if (branchDefault) return branchDefault;
  const global = roles.get("*")?.get(actor.id) ?? roles.get("*")?.get("*");
  return global ?? "none";
}

/** True when the actor may perform the action on the branch. */
export function can(
  roles: RoleTable,
  branch: Branch,
  actor: Actor,
  action: BranchAction
): boolean {
  return roleCan(resolveRole(roles, branch.name, actor), action);
}

/**
 * Throws unless the actor may perform the action. Protected branches escalate
 * `commit` to `maintain` and `delete-branch` to `admin`, and block
 * `unprotect`/`protect` for anyone who is not already an admin.
 */
export function assertCan(
  roles: RoleTable,
  branch: Branch,
  actor: Actor,
  action: BranchAction
): void {
  const role = resolveRole(roles, branch.name, actor);

  if (branch.protected && action === "commit" && !roleAtLeast(role, "maintain")) {
    throw new BranchError(
      "permission-denied",
      `branch ${branch.name} is protected: commit requires maintain or admin, ${actor.id} has ${role}`
    );
  }
  if (branch.protected && action === "merge" && !roleAtLeast(role, "maintain")) {
    throw new BranchError(
      "permission-denied",
      `branch ${branch.name} is protected: merge requires maintain or admin, ${actor.id} has ${role}`
    );
  }
  if (branch.protected && action === "delete-branch" && !roleAtLeast(role, "admin")) {
    throw new BranchError(
      "permission-denied",
      `branch ${branch.name} is protected: delete requires admin, ${actor.id} has ${role}`
    );
  }
  if (!branch.protected && action === "delete-branch" && !roleAtLeast(role, "maintain")) {
    throw new BranchError(
      "permission-denied",
      `delete requires maintain or admin, ${actor.id} has ${role}`
    );
  }
  if (branch.protected && action === "unprotect" && !roleAtLeast(role, "admin")) {
    throw new BranchError(
      "permission-denied",
      `unprotecting ${branch.name} requires admin, ${actor.id} has ${role}`
    );
  }

  if (!roleCan(role, action)) {
    throw new BranchError(
      "permission-denied",
      `${actor.id} has role ${role} on ${branch.name}, which does not allow ${action} (requires ${minimumRole(action)})`
    );
  }
}

/** Actions a role cannot perform on a branch, for building an access UI. */
export function deniedActions(roles: RoleTable, branch: Branch, actor: Actor): BranchAction[] {
  const all: BranchAction[] = [
    "read",
    "create-branch",
    "delete-branch",
    "commit",
    "merge",
    "resolve",
    "protect",
    "unprotect",
    "force-update",
  ];
  return all.filter((action) => {
    try {
      assertCan(roles, branch, actor, action);
      return false;
    } catch {
      return true;
    }
  });
}
