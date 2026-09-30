/**
 * Contract event branching and merge manager (#429)
 *
 * Holds the commit history, the branch heads, the role table, and any merge
 * waiting on a human. Every mutating operation goes through a permission check
 * and every failure raises a `BranchError` with a stable code.
 */

import {
  ancestorsOf,
  changeKey,
  detectConflicts,
  findMergeBase,
  incomingChanges,
  isAncestor,
  parseKey,
  toChange,
} from "./merge.ts";
import { assertCan, can, resolveRole } from "./permissions.ts";
import type { RoleTable } from "./permissions.ts";
import { BranchError } from "./types.ts";
import type {
  Actor,
  Branch,
  BranchAction,
  BranchRole,
  Commit,
  Conflict,
  EventChange,
  FieldState,
  MergeOutcome,
  MergeStrategy,
  PendingMerge,
} from "./types.ts";

export interface EventBranchManagerOptions {
  /** Branch created on init and treated as non deletable. */
  defaultBranch?: string;
  now?: () => number;
  /** Sequence source for commit ids; injectable for deterministic tests. */
  nextId?: (prefix: string) => string;
}

export interface CommitInput {
  author: string;
  message: string;
  changes: EventChange[];
  timestamp?: number;
}

export interface CreateBranchInput {
  name: string;
  from?: string;
  fromCommit?: string;
  actor: Actor;
  description?: string;
  protected?: boolean;
}

const DEFAULT_BRANCH = "main";
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$/;

export class EventBranchManager {
  private readonly commits = new Map<string, Commit>();
  private readonly branches = new Map<string, Branch>();
  private readonly roles: RoleTable = new Map();
  private readonly pending = new Map<string, PendingMerge>();
  private readonly defaultBranch: string;
  private readonly now: () => number;
  private readonly nextId: (prefix: string) => string;
  private counter = 0;

  constructor(options: EventBranchManagerOptions = {}) {
    this.defaultBranch = options.defaultBranch ?? DEFAULT_BRANCH;
    this.now = options.now ?? (() => Date.now());
    this.nextId =
      options.nextId ??
      ((prefix) => {
        this.counter += 1;
        return `${prefix}-${this.counter.toString(36).padStart(4, "0")}`;
      });
    this.branches.set(this.defaultBranch, {
      name: this.defaultBranch,
      head: null,
      createdAt: this.now(),
      createdBy: "system",
      protected: true,
      allowNonFastForward: true,
      description: "Default branch",
    });
  }

  // ── branches ────────────────────────────────────────────────────────────

  /** Creates a branch, by default from the head of the current branch. */
  createBranch(input: CreateBranchInput): Branch {
    if (!NAME_PATTERN.test(input.name)) {
      throw new BranchError("invalid-name", `branch name ${input.name} is not allowed`);
    }
    if (this.branches.has(input.name)) {
      throw new BranchError("branch-exists", `branch ${input.name} already exists`);
    }
    const source =
      input.from === undefined ? this.requireBranch(this.defaultBranch) : this.fromBranch(input.from);
    assertCan(this.roles, source, input.actor, "create-branch");

    const base = input.fromCommit ?? source.head;
    if (input.fromCommit !== undefined && !this.commits.has(input.fromCommit)) {
      throw new BranchError("unknown-commit", `commit ${input.fromCommit} does not exist`);
    }

    const branch: Branch = {
      name: input.name,
      head: base,
      createdAt: this.now(),
      createdBy: input.actor.id,
      protected: input.protected ?? false,
      allowNonFastForward: true,
      description: input.description,
    };
    this.branches.set(branch.name, branch);
    return { ...branch };
  }

  listBranches(): Branch[] {
    return [...this.branches.values()].map((branch) => ({ ...branch }));
  }

  getBranch(name: string): Branch | undefined {
    const branch = this.branches.get(name);
    return branch === undefined ? undefined : { ...branch };
  }

  /** Deletes a branch. Protected and default branches cannot be deleted. */
  deleteBranch(name: string, actor: Actor, options: { force?: boolean } = {}): boolean {
    const branch = this.requireBranch(name);
    if (name === this.defaultBranch) {
      throw new BranchError("protected-branch", `the default branch ${name} cannot be deleted`);
    }
    assertCan(this.roles, branch, actor, "delete-branch");
    if (!options.force) {
      const unmerged = this.listBranches().filter(
        (other) =>
          other.name !== name &&
          other.head !== null &&
          !isAncestor(this.commits, branch.head, other.head)
      );
      if (unmerged.length > 0) {
        throw new BranchError(
          "branch-not-empty",
          `branch ${name} has commits not merged into ${unmerged.map((item) => item.name).join(", ")}`
        );
      }
    }
    return this.branches.delete(name);
  }

  /** Toggles branch protection. Requires admin. */
  setProtection(name: string, protectedBranch: boolean, actor: Actor): Branch {
    const branch = this.requireBranch(name);
    assertCan(this.roles, branch, actor, protectedBranch ? "protect" : "unprotect");
    branch.protected = protectedBranch;
    return { ...branch };
  }

  /** Restricts a branch to fast-forward merges only. Requires maintain. */
  setFastForwardOnly(name: string, fastForwardOnly: boolean, actor: Actor): Branch {
    const branch = this.requireBranch(name);
    assertCan(this.roles, branch, actor, "force-update");
    branch.allowNonFastForward = !fastForwardOnly;
    return { ...branch };
  }

  // ── commits ─────────────────────────────────────────────────────────────

  /** Appends a commit to a branch, moving the branch head. */
  commit(branchName: string, input: CommitInput, actor: Actor): Commit {
    const branch = this.requireBranch(branchName);
    assertCan(this.roles, branch, actor, "commit");
    if (input.changes.length === 0) {
      throw new BranchError("branch-not-empty", "a commit must change at least one field");
    }
    const commit: Commit = {
      id: this.nextId("c"),
      branch: branchName,
      parents: branch.head === null ? [] : [branch.head],
      author: input.author,
      message: input.message,
      timestamp: input.timestamp ?? this.now(),
      changes: input.changes.map((change) => ({ ...change })),
    };
    this.commits.set(commit.id, commit);
    branch.head = commit.id;
    return { ...commit };
  }

  getCommit(id: string): Commit | undefined {
    const commit = this.commits.get(id);
    return commit === undefined ? undefined : { ...commit };
  }

  /** History of a branch, newest first. */
  log(branchName: string, limit?: number): Commit[] {
    const branch = this.requireBranch(branchName);
    const commits = ancestorsOf(this.commits, branch.head).map((id) => this.commits.get(id) as Commit);
    return limit === undefined ? commits : commits.slice(0, limit);
  }

  /** True when `candidate` is reachable from `descendant`. */
  isAncestorOf(candidate: string, descendant: string): boolean {
    return isAncestor(this.commits, candidate, descendant);
  }

  /** Best common ancestor of two branch heads. */
  mergeBase(left: string, right: string): string | null {
    return findMergeBase(this.commits, this.requireBranch(left).head, this.requireBranch(right).head);
  }

  /** Resolved field state of a resource at a branch head. */
  snapshot(branchName: string, resourceId?: string): Record<string, unknown> {
    const branch = this.requireBranch(branchName);
    const state = this.replayTo(branch.head);
    const result: Record<string, unknown> = {};
    for (const [key, value] of state) {
      const { resourceId: id, field } = parseKey(key);
      if (resourceId !== undefined && id !== resourceId) continue;
      if (!value.present) continue;
      result[field] = value.value;
    }
    return result;
  }

  // ── merge ───────────────────────────────────────────────────────────────

  /**
   * Merges `source` into `target`.
   *
   * Fast-forward when the target has not moved since the merge base. Otherwise
   * a three-way merge: clean fields are applied immediately, and conflicting
   * fields are either resolved by `strategy` or, for `manual`, parked in a
   * pending merge to finish with `resolve()`.
   */
  merge(
    source: string,
    target: string,
    options: { actor: Actor; strategy?: MergeStrategy; author?: string; message?: string }
  ): MergeOutcome {
    const sourceBranch = this.requireBranch(source);
    const targetBranch = this.requireBranch(target);
    const strategy = options.strategy ?? "auto";
    assertCan(this.roles, targetBranch, options.actor, "merge");
    if (source === target) {
      return this.outcome(source, target, "up-to-date", { strategy });
    }

    const base = findMergeBase(this.commits, targetBranch.head, sourceBranch.head);
    if (base === null) {
      throw new BranchError(
        "unrelated-histories",
        `branches ${source} and ${target} share no common ancestor`
      );
    }
    if (isAncestor(this.commits, sourceBranch.head, targetBranch.head)) {
      return this.outcome(source, target, "up-to-date", { strategy, mergeBase: base });
    }
    if (base === targetBranch.head && targetBranch.allowNonFastForward) {
      targetBranch.head = sourceBranch.head;
      return this.outcome(source, target, "fast-forward", { strategy, mergeBase: base });
    }
    if (!targetBranch.allowNonFastForward) {
      throw new BranchError(
        "non-fast-forward",
        `branch ${target} only accepts fast-forward merges`
      );
    }

    const baseState = this.replayTo(base);
    const ourState = this.replayTo(targetBranch.head);
    const theirState = this.replayTo(sourceBranch.head);
    const conflicts = detectConflicts(baseState, ourState, theirState);
    const applied = incomingChanges(theirState, ourState, baseState);

    if (conflicts.length === 0) {
      const commit = this.writeMergeCommit(target, targetBranch, sourceBranch, applied, options);
      return {
        status: "merged",
        source,
        target,
        commitId: commit,
        mergeBase: base,
        applied,
        conflicts: [],
        strategy,
      };
    }

    if (strategy === "ours" || strategy === "theirs") {
      const chosen = this.applyStrategy(conflicts, strategy, applied);
      const commit = this.writeMergeCommit(target, targetBranch, sourceBranch, chosen, options);
      return {
        status: "merged",
        source,
        target,
        commitId: commit,
        mergeBase: base,
        applied: chosen,
        conflicts,
        strategy,
      };
    }

    const id = this.nextId("merge");
    this.pending.set(id, {
      id,
      source,
      target,
      mergeBase: base,
      applied,
      conflicts,
      author: options.author ?? options.actor.id,
      createdAt: this.now(),
    });
    return {
      status: "conflicted",
      source,
      target,
      commitId: null,
      mergeBase: base,
      applied,
      conflicts,
      strategy,
    };
  }

  /** Completes a manual merge by resolving every conflict. */
  resolve(
    pendingId: string,
    resolutions: Record<string, "ours" | "theirs">,
    options: { actor: Actor; author?: string; message?: string }
  ): MergeOutcome {
    const merge = this.pending.get(pendingId);
    if (!merge) {
      throw new BranchError("unknown-pending-merge", `no pending merge ${pendingId}`);
    }
    const targetBranch = this.requireBranch(merge.target);
    const sourceBranch = this.requireBranch(merge.source);
    assertCan(this.roles, targetBranch, options.actor, "resolve");

    const applied = [...merge.applied];
    for (const conflict of merge.conflicts) {
      const key = conflictKey(conflict);
      const choice = resolutions[key];
      if (choice !== "ours" && choice !== "theirs") {
        throw new BranchError(
          "unresolved-conflicts",
          `conflict ${key} is unresolved: expected "ours" or "theirs"`
        );
      }
      const state = choice === "ours" ? conflict.ours : conflict.theirs;
      applied.push(toChange(conflict.resourceId, conflict.field, state) as EventChange);
    }

    const commit = this.writeMergeCommit(
      merge.target,
      targetBranch,
      sourceBranch,
      applied,
      {
        ...options,
        author: options.author ?? merge.author,
        message: options.message ?? `Merge ${merge.source} into ${merge.target}`,
      }
    );
    this.pending.delete(pendingId);
    return {
      status: "merged",
      source: merge.source,
      target: merge.target,
      commitId: commit,
      mergeBase: merge.mergeBase,
      applied,
      conflicts: merge.conflicts,
      strategy: "manual",
    };
  }

  /** Merges awaiting a human decision. */
  pendingMerges(): PendingMerge[] {
    return [...this.pending.values()].map((merge) => ({ ...merge, conflicts: [...merge.conflicts] }));
  }

  /** Abandons a pending merge. */
  cancelMerge(pendingId: string): boolean {
    return this.pending.delete(pendingId);
  }

  // ── permissions ─────────────────────────────────────────────────────────

  /** Grants a role to a principal. `*` matches every principal or branch. */
  setRole(branch: string, principal: string, role: BranchRole): void {
    let table = this.roles.get(branch);
    if (!table) {
      table = new Map();
      this.roles.set(branch, table);
    }
    table.set(principal, role);
  }

  roleOf(branch: string, actor: Actor): BranchRole {
    return resolveRole(this.roles, branch, actor);
  }

  /** The role table for a branch, for rendering an access list. */
  rolesFor(branch: string): Record<string, BranchRole> {
    this.requireBranch(branch);
    return Object.fromEntries(this.roles.get(branch) ?? new Map());
  }

  can(branch: string, actor: Actor, action: BranchAction): boolean {
    return can(this.roles, this.requireBranch(branch), actor, action);
  }

  // ── internals ───────────────────────────────────────────────────────────

  private fromBranch(name: string): Branch {
    return this.requireBranch(name);
  }

  private requireBranch(name: string): Branch {
    const branch = this.branches.get(name);
    if (!branch) throw new BranchError("unknown-branch", `branch ${name} does not exist`);
    return branch;
  }

  private replayTo(commitId: string | null): Map<string, FieldState> {
    const ordered: Commit[] = [];
    const visited = new Set<string>();
    const expanding = new Set<string>();
    const stack: string[] = commitId === null ? [] : [commitId];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (visited.has(current)) continue;
      const commit = this.commits.get(current);
      if (!commit) continue;
      if (expanding.has(current)) {
        expanding.delete(current);
        visited.add(current);
        ordered.push(commit);
        continue;
      }
      expanding.add(current);
      stack.push(current);
      for (let i = commit.parents.length - 1; i >= 0; i--) {
        const parent = commit.parents[i];
        if (!visited.has(parent) && !expanding.has(parent)) stack.push(parent);
      }
    }
    let snapshot = new Map<string, FieldState>();
    for (const commit of ordered) {
      for (const change of commit.changes) {
        snapshot.set(changeKey(change), {
          present: change.op !== "delete",
          value: change.op === "delete" ? undefined : change.value,
        });
      }
    }
    return snapshot;
  }

  private applyStrategy(
    conflicts: Conflict[],
    strategy: "ours" | "theirs",
    applied: EventChange[]
  ): EventChange[] {
    const changes = [...applied];
    for (const conflict of conflicts) {
      const state = strategy === "ours" ? conflict.ours : conflict.theirs;
      changes.push(toChange(conflict.resourceId, conflict.field, state) as EventChange);
    }
    return changes;
  }

  private writeMergeCommit(
    target: string,
    targetBranch: Branch,
    sourceBranch: Branch,
    changes: EventChange[],
    options: { actor: Actor; author?: string; message?: string }
  ): string {
    // The merge permission was already checked by the caller, so the commit is
    // written directly instead of re-entering the commit permission path.
    const commit: Commit = {
      id: this.nextId("c"),
      branch: target,
      parents:
        targetBranch.head === null ? [sourceBranch.head] : [targetBranch.head, sourceBranch.head],
      author: options.author ?? options.actor.id,
      message: options.message ?? `Merge ${sourceBranch.name} into ${target}`,
      timestamp: this.now(),
      changes: dedupeChanges(changes),
      merge: true,
    };
    this.commits.set(commit.id, commit);
    targetBranch.head = commit.id;
    return commit.id;
  }

  private outcome(
    source: string,
    target: string,
    status: MergeOutcome["status"],
    extra: { strategy: MergeStrategy; mergeBase?: string | null }
  ): MergeOutcome {
    return {
      status,
      source,
      target,
      commitId: null,
      mergeBase: extra.mergeBase ?? null,
      applied: [],
      conflicts: [],
      strategy: extra.strategy,
    };
  }
}

/** Composite key used to address a conflict in a resolution map. */
export function conflictKey(conflict: Conflict): string {
  return `${conflict.resourceId}.${conflict.field}`;
}

function dedupeChanges(changes: EventChange[]): EventChange[] {
  const byKey = new Map<string, EventChange>();
  for (const change of changes) byKey.set(changeKey(change), change);
  return [...byKey.values()];
}
