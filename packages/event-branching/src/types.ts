/**
 * Contract event branching and merge types (#429)
 *
 * A contract event workflow is modelled the way a Git repository is: an append
 * only history of commits, named branches pointing at a head commit, and merges
 * that reconcile two divergent lines. Nothing is ever rewritten in place, so
 * the audit trail of a collaboration is as durable as the ledger itself.
 */

export type ChangeOp = "set" | "delete";

/** One field level change to an event resource. */
export interface EventChange {
  resourceId: string;
  field: string;
  op: ChangeOp;
  value?: unknown;
}

export interface Commit {
  id: string;
  /** Branch the commit was appended to. */
  branch: string;
  parents: string[];
  author: string;
  message: string;
  timestamp: number;
  changes: EventChange[];
  /** Set on commits produced by a merge. */
  merge?: boolean;
}

export interface Branch {
  name: string;
  head: string | null;
  createdAt: number;
  createdBy: string;
  /** Protected branches reject deletion and require elevated roles to merge. */
  protected: boolean;
  /** When false, only fast-forward merges are accepted. */
  allowNonFastForward: boolean;
  description?: string;
}

export type BranchRole = "none" | "read" | "write" | "maintain" | "admin";

export type BranchAction =
  | "read"
  | "create-branch"
  | "delete-branch"
  | "commit"
  | "merge"
  | "resolve"
  | "protect"
  | "unprotect"
  | "force-update";

/** Who is performing an operation. */
export interface Actor {
  id: string;
  /** Overrides the repository role table when supplied. */
  role?: BranchRole;
}

/** How a merge should behave when both sides changed the same field. */
export type MergeStrategy = "auto" | "ours" | "theirs" | "manual";

/** A value at a point in history, tracking whether it exists at all. */
export interface FieldState {
  present: boolean;
  value?: unknown;
}

export interface Conflict {
  resourceId: string;
  field: string;
  base: FieldState;
  ours: FieldState;
  theirs: FieldState;
}

export type MergeStatus = "fast-forward" | "merged" | "conflicted" | "up-to-date";

export interface MergeOutcome {
  status: MergeStatus;
  source: string;
  target: string;
  commitId: string | null;
  mergeBase: string | null;
  /** Changes that merged cleanly and were written by the merge commit. */
  applied: EventChange[];
  conflicts: Conflict[];
  strategy: MergeStrategy;
  /** Set when the merge could not be attempted at all. */
  error?: string;
}

export interface PendingMerge {
  id: string;
  source: string;
  target: string;
  mergeBase: string | null;
  applied: EventChange[];
  conflicts: Conflict[];
  author: string;
  createdAt: number;
}

export type MergeErrorCode =
  | "unknown-branch"
  | "branch-exists"
  | "branch-not-empty"
  | "protected-branch"
  | "unknown-commit"
  | "unknown-pending-merge"
  | "unrelated-histories"
  | "permission-denied"
  | "non-fast-forward"
  | "invalid-name"
  | "unresolved-conflicts";

/** Error carrying a stable machine readable code. */
export class BranchError extends Error {
  readonly code: MergeErrorCode;

  constructor(code: MergeErrorCode, message: string) {
    super(message);
    this.name = "BranchError";
    this.code = code;
  }
}
