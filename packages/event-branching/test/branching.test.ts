import assert from "node:assert/strict";
import test from "node:test";

import {
  BranchError,
  EventBranchManager,
  ancestorsOf,
  assertCan,
  capabilitiesFor,
  changeKey,
  conflictKey,
  deniedActions,
  detectConflicts,
  findMergeBase,
  isAncestor,
  minimumRole,
  parseKey,
  replay,
  resolveRole,
  roleCan,
  stateAfter,
  toChange,
} from "../src/index.ts";
import type { Actor, Commit, EventChange, FieldState, RoleTable } from "../src/index.ts";

const NOW = 1_700_000_000_000;

const admin: Actor = { id: "alice", role: "admin" };
const maintainer: Actor = { id: "bob", role: "maintain" };
const writer: Actor = { id: "carol", role: "write" };
const reader: Actor = { id: "dave", role: "read" };

function set(resourceId: string, field: string, value: unknown): EventChange {
  return { resourceId, field, op: "set", value };
}

function manager(): EventBranchManager {
  let clock = NOW;
  return new EventBranchManager({ now: () => (clock += 1000) });
}

function commitOn(repo: EventBranchManager, branch: string, changes: EventChange[], message = "work"): Commit {
  return repo.commit(branch, { author: "dev", message, changes }, admin);
}

function commitMap(repo: EventBranchManager): Map<string, Commit> {
  const map = new Map<string, Commit>();
  for (const branch of repo.listBranches()) {
    for (const commit of repo.log(branch.name)) map.set(commit.id, commit);
  }
  return map;
}

/** Rebuilds a RoleTable from a manager so the pure helpers can be tested. */
function roleTable(repo: EventBranchManager, branch: string): RoleTable {
  return new Map([[branch, new Map(Object.entries(repo.rolesFor(branch)))]]);
}

test("changeKey and parseKey round trip", () => {
  const key = changeKey(set("evt-1", "status", "closed"));
  assert.deepEqual(parseKey(key), { resourceId: "evt-1", field: "status" });
  assert.equal(parseKey("x").field, undefined, "a bare key has no field part");
});

test("the default branch exists, is protected, and cannot be deleted", () => {
  const repo = manager();
  const main = repo.getBranch("main");
  assert.equal(main?.protected, true);
  assert.equal(main?.head, null);
  assert.throws(
    () => repo.deleteBranch("main", admin),
    (error: unknown) => error instanceof BranchError && error.code === "protected-branch"
  );
  assert.equal(repo.getBranch("main") !== undefined, true);
});

test("a custom default branch name is honoured", () => {
  const repo = new EventBranchManager({ defaultBranch: "ledger" });
  assert.deepEqual(
    repo.listBranches().map((branch) => branch.name),
    ["ledger"]
  );
});

test("branches are created from the head of the source branch", () => {
  const repo = manager();
  const first = commitOn(repo, "main", [set("evt-1", "status", "open")]);
  const feature = repo.createBranch({ name: "feature/kyc", from: "main", actor: admin });

  assert.equal(feature.head, first.id);
  assert.equal(feature.createdBy, "alice");
  assert.equal(feature.protected, false);
  assert.deepEqual(
    repo.listBranches().map((branch) => branch.name),
    ["main", "feature/kyc"]
  );
});

test("branch names are validated and must be unique", () => {
  const repo = manager();
  assert.throws(
    () => repo.createBranch({ name: "bad name", actor: admin }),
    (error: unknown) => error instanceof BranchError && error.code === "invalid-name"
  );
  repo.createBranch({ name: "topic", actor: admin });
  assert.throws(
    () => repo.createBranch({ name: "topic", actor: admin }),
    (error: unknown) => error instanceof BranchError && error.code === "branch-exists"
  );
});

test("branching from an unknown branch or commit fails", () => {
  const repo = manager();
  assert.throws(
    () => repo.createBranch({ name: "topic", from: "nope", actor: admin }),
    (error: unknown) => error instanceof BranchError && error.code === "unknown-branch"
  );
  assert.throws(
    () => repo.createBranch({ name: "topic", fromCommit: "c-9999", actor: admin }),
    (error: unknown) => error instanceof BranchError && error.code === "unknown-commit"
  );
});

test("commits append to the branch head and thread the parent chain", () => {
  const repo = manager();
  const first = commitOn(repo, "main", [set("evt-1", "status", "open")]);
  const second = commitOn(repo, "main", [set("evt-1", "status", "closed")]);

  assert.deepEqual(second.parents, [first.id]);
  assert.equal(repo.getBranch("main")?.head, second.id);
  assert.deepEqual(
    repo.log("main").map((commit) => commit.id),
    [second.id, first.id]
  );
  assert.equal(repo.isAncestorOf(first.id, second.id), true);
  assert.equal(repo.isAncestorOf(second.id, first.id), false);
});

test("a commit must change at least one field", () => {
  const repo = manager();
  assert.throws(
    () => repo.commit("main", { author: "dev", message: "noop", changes: [] }, admin),
    (error: unknown) => error instanceof BranchError && error.code === "branch-not-empty"
  );
});

test("snapshot resolves the field state at a branch head", () => {
  const repo = manager();
  commitOn(repo, "main", [set("evt-1", "status", "open"), set("evt-1", "owner", "alice")]);
  commitOn(repo, "main", [
    { resourceId: "evt-1", field: "status", op: "delete" },
    set("evt-2", "status", "open"),
  ]);

  assert.deepEqual(repo.snapshot("main", "evt-1"), { owner: "alice" });
  assert.deepEqual(repo.snapshot("main", "evt-2"), { status: "open" });
  assert.deepEqual(repo.snapshot("main"), { owner: "alice", status: "open" });
});

test("a fast-forward merge moves the target head without a merge commit", () => {
  const repo = manager();
  commitOn(repo, "main", [set("evt-1", "status", "open")]);
  const feature = repo.createBranch({ name: "feature", from: "main", actor: admin });
  const tip = commitOn(repo, "feature", [set("evt-1", "status", "reviewed")]);

  const outcome = repo.merge("feature", "main", { actor: admin });

  assert.equal(outcome.status, "fast-forward");
  assert.equal(outcome.commitId, null);
  assert.equal(outcome.mergeBase, feature.head);
  assert.equal(repo.getBranch("main")?.head, tip.id);
  assert.deepEqual(repo.snapshot("main", "evt-1"), { status: "reviewed" });
});

test("merging a branch into itself, or an ancestor, is a no-op", () => {
  const repo = manager();
  const first = commitOn(repo, "main", [set("evt-1", "status", "open")]);
  repo.createBranch({ name: "feature", from: "main", actor: admin });

  assert.equal(repo.merge("main", "main", { actor: admin }).status, "up-to-date");
  const outcome = repo.merge("main", "feature", { actor: admin });
  assert.equal(outcome.status, "up-to-date");
  assert.equal(repo.getBranch("feature")?.head, first.id);
});

test("unrelated histories are rejected", () => {
  const repo = new EventBranchManager({ defaultBranch: "main" });
  const other = repo.createBranch({ name: "isolated", actor: admin });
  assert.equal(other.head, null);
  commitOn(repo, "isolated", [set("evt-1", "status", "open")]);

  assert.throws(
    () => repo.merge("isolated", "main", { actor: admin }),
    (error: unknown) => error instanceof BranchError && error.code === "unrelated-histories"
  );
});

test("a three-way merge applies clean fields and reports conflicts", () => {
  const repo = manager();
  const base = commitOn(repo, "main", [
    set("evt-1", "status", "open"),
    set("evt-1", "owner", "alice"),
    set("evt-1", "severity", "low"),
  ]);
  repo.createBranch({ name: "feature", from: "main", actor: admin });
  commitOn(repo, "main", [set("evt-1", "owner", "bob")]);
  commitOn(repo, "feature", [
    set("evt-1", "status", "closed"),
    set("evt-1", "severity", "high"),
  ]);

  const outcome = repo.merge("feature", "main", { actor: admin, strategy: "auto" });

  assert.equal(outcome.status, "merged");
  assert.equal(outcome.mergeBase, base.id);
  assert.deepEqual(
    outcome.applied.map((change) => `${change.field}=${String(change.value)}`),
    ["severity=high", "status=closed"]
  );
  assert.equal(outcome.conflicts.length, 0, "owner was only changed on our side");
});

test("a field changed differently on both sides conflicts", () => {
  const repo = manager();
  const base = commitOn(repo, "main", [set("evt-1", "status", "open")]);
  repo.createBranch({ name: "feature", from: "main", actor: admin });
  commitOn(repo, "main", [set("evt-1", "status", "closed")]);
  commitOn(repo, "feature", [set("evt-1", "status", "rejected")]);

  const outcome = repo.merge("feature", "main", { actor: admin, strategy: "auto" });

  assert.equal(outcome.status, "conflicted");
  assert.equal(outcome.conflicts.length, 1);
  const conflict = outcome.conflicts[0];
  assert.equal(conflict.field, "status");
  assert.equal(conflict.base.value, "open");
  assert.equal(conflict.ours.value, "closed");
  assert.equal(conflict.theirs.value, "rejected");
  assert.equal(conflictKey(conflict), "evt-1.status");
  assert.equal(repo.getBranch("main")?.head !== base.id, true);
  assert.equal(repo.snapshot("main", "evt-1").status, "closed", "target is untouched");
});

test("the ours and theirs strategies resolve conflicts without a human", () => {
  const build = (): EventBranchManager => {
    const repo = manager();
    commitOn(repo, "main", [set("evt-1", "status", "open")]);
    repo.createBranch({ name: "feature", from: "main", actor: admin });
    commitOn(repo, "main", [set("evt-1", "status", "closed")]);
    commitOn(repo, "feature", [set("evt-1", "status", "rejected")]);
    return repo;
  };

  const ours = build();
  const oursOutcome = ours.merge("feature", "main", { actor: admin, strategy: "ours" });
  assert.equal(oursOutcome.status, "merged");
  assert.equal(oursOutcome.conflicts.length, 1);
  assert.equal(ours.snapshot("main", "evt-1").status, "closed");

  const theirs = build();
  theirs.merge("feature", "main", { actor: admin, strategy: "theirs" });
  assert.equal(theirs.snapshot("main", "evt-1").status, "rejected");
});

test("a manual merge is parked until every conflict is resolved", () => {
  const repo = manager();
  commitOn(repo, "main", [set("evt-1", "status", "open")]);
  repo.createBranch({ name: "feature", from: "main", actor: admin });
  commitOn(repo, "main", [set("evt-1", "status", "closed")]);
  commitOn(repo, "feature", [set("evt-1", "status", "rejected")]);

  const parked = repo.merge("feature", "main", { actor: admin, strategy: "manual" });
  assert.equal(parked.status, "conflicted");
  assert.equal(parked.commitId, null);
  assert.equal(repo.pendingMerges().length, 1);
  const pending = repo.pendingMerges()[0];

  assert.throws(
    () => repo.resolve(pending.id, {}, { actor: admin }),
    (error: unknown) => error instanceof BranchError && error.code === "unresolved-conflicts"
  );
  assert.throws(
    () => repo.resolve("merge-9999", { "evt-1.status": "ours" }, { actor: admin }),
    (error: unknown) => error instanceof BranchError && error.code === "unknown-pending-merge"
  );

  const resolved = repo.resolve(pending.id, { "evt-1.status": "theirs" }, { actor: admin });
  assert.equal(resolved.status, "merged");
  assert.equal(resolved.strategy, "manual");
  assert.equal(repo.snapshot("main", "evt-1").status, "rejected");
  assert.equal(repo.pendingMerges().length, 0);

  const commit = repo.getCommit(resolved.commitId as string);
  assert.equal(commit?.merge, true);
  assert.equal(commit?.parents.length, 2);
  assert.equal(repo.cancelMerge("merge-0000"), false);
});

test("a merge commit records both parents and replays cleanly", () => {
  const repo = manager();
  const base = commitOn(repo, "main", [set("evt-1", "a", "1"), set("evt-1", "b", "1")]);
  const feature = repo.createBranch({ name: "feature", from: "main", actor: admin });
  const mainTip = commitOn(repo, "main", [set("evt-1", "a", "main")]);
  const featureTip = commitOn(repo, "feature", [set("evt-1", "b", "feature")]);

  const outcome = repo.merge("feature", "main", { actor: admin });
  assert.equal(outcome.status, "merged");
  assert.equal(outcome.commitId !== null, true);

  const commit = repo.getCommit(outcome.commitId as string);
  assert.deepEqual(commit?.parents, [mainTip.id, featureTip.id]);
  assert.equal(repo.isAncestorOf(base.id, outcome.commitId as string), true);
  assert.equal(repo.isAncestorOf(featureTip.id, outcome.commitId as string), true);
  assert.equal(repo.getBranch("feature")?.head, featureTip.id);
  assert.deepEqual(repo.snapshot("main", "evt-1"), { a: "main", b: "feature" });
  assert.equal(repo.snapshot("feature", "evt-1").b, "feature");
});

test("identical changes on both sides merge without a conflict", () => {
  const repo = manager();
  commitOn(repo, "main", [set("evt-1", "status", "open")]);
  repo.createBranch({ name: "feature", from: "main", actor: admin });
  commitOn(repo, "main", [set("evt-1", "status", "closed")]);
  commitOn(repo, "feature", [set("evt-1", "status", "closed")]);

  const outcome = repo.merge("feature", "main", { actor: admin });
  assert.equal(outcome.status, "merged");
  assert.deepEqual(outcome.conflicts, []);
  assert.equal(repo.snapshot("main", "evt-1").status, "closed");
});

test("a delete on one side and an edit on the other conflicts", () => {
  const repo = manager();
  commitOn(repo, "main", [set("evt-1", "note", "keep")]);
  repo.createBranch({ name: "feature", from: "main", actor: admin });
  commitOn(repo, "main", [{ resourceId: "evt-1", field: "note", op: "delete" }]);
  commitOn(repo, "feature", [set("evt-1", "note", "edited")]);

  const outcome = repo.merge("feature", "main", { actor: admin, strategy: "auto" });
  assert.equal(outcome.status, "conflicted");
  assert.equal(outcome.conflicts[0].ours.present, false);
  assert.equal(outcome.conflicts[0].theirs.value, "edited");

  const pending = repo.pendingMerges()[0];
  repo.resolve(pending.id, { "evt-1.note": "ours" }, { actor: admin });
  assert.deepEqual(repo.snapshot("main", "evt-1"), {}, "the delete won");
});

test("fast-forward-only branches reject a real merge", () => {
  const repo = manager();
  commitOn(repo, "main", [set("evt-1", "a", "1")]);
  repo.createBranch({ name: "stable", from: "main", actor: admin });
  commitOn(repo, "main", [set("evt-1", "a", "2")]);
  commitOn(repo, "stable", [set("evt-1", "a", "3")]);
  repo.setFastForwardOnly("main", true, admin);
  assert.equal(repo.getBranch("main")?.allowNonFastForward, false);

  assert.throws(
    () => repo.merge("stable", "main", { actor: admin }),
    (error: unknown) => error instanceof BranchError && error.code === "non-fast-forward"
  );
});

test("roles form a capability hierarchy", () => {
  assert.equal(roleCan("read", "read"), true);
  assert.equal(roleCan("read", "commit"), false);
  assert.equal(roleCan("write", "commit"), true);
  assert.equal(roleCan("write", "merge"), false);
  assert.equal(roleCan("maintain", "merge"), true);
  assert.equal(roleCan("maintain", "protect"), false);
  assert.equal(roleCan("admin", "unprotect"), true);
  assert.equal(minimumRole("merge"), "maintain");
  assert.equal(minimumRole("commit"), "write");
  assert.equal(capabilitiesFor("none").length, 1);
});

test("resolveRole prefers branch grants over global ones and wildcards", () => {
  const repo = manager();
  repo.setRole("*", "alice", "read");
  repo.setRole("*", "*", "read");
  repo.setRole("main", "alice", "admin");

  assert.equal(repo.roleOf("main", { id: "alice" }), "admin");
  assert.equal(repo.roleOf("main", { id: "bob" }), "read");
  assert.equal(repo.roleOf("other", { id: "alice" }), "read");
  assert.equal(repo.roleOf("other", { id: "zoe" }), "read");
  assert.equal(resolveRole(new Map(), "main", { id: "x", role: "maintain" }), "maintain");
});

test("committing requires write access", () => {
  const repo = manager();
  repo.setProtection("main", false, admin);
  repo.setRole("main", "carol", "write");
  assert.doesNotThrow(() => repo.commit("main", { author: "c", message: "m", changes: [set("e", "f", 1)] }, writer));
  assert.throws(
    () => repo.commit("main", { author: "d", message: "m", changes: [set("e", "f", 2)] }, reader),
    (error: unknown) => error instanceof BranchError && error.code === "permission-denied"
  );
  assert.equal(repo.can("main", reader, "commit"), false);
  assert.equal(repo.can("main", writer, "commit"), true);
});

test("a protected branch escalates commit to maintain", () => {
  const repo = manager();
  repo.setRole("main", "carol", "write");
  assert.throws(
    () => repo.commit("main", { author: "c", message: "m", changes: [set("e", "f", 1)] }, writer),
    /is protected: commit requires maintain/
  );
  assert.doesNotThrow(() =>
    repo.commit("main", { author: "b", message: "m", changes: [set("e", "f", 1)] }, maintainer)
  );
});

test("merging into a protected branch requires maintain", () => {
  const repo = manager();
  commitOn(repo, "main", [set("evt-1", "a", "1")]);
  repo.createBranch({ name: "feature", from: "main", actor: admin });
  commitOn(repo, "feature", [set("evt-1", "a", "2")]);
  repo.setRole("main", "carol", "write");

  assert.throws(
    () => repo.merge("feature", "main", { actor: writer }),
    (error: unknown) => error instanceof BranchError && error.code === "permission-denied"
  );
  assert.doesNotThrow(() => repo.merge("feature", "main", { actor: maintainer }));
});

test("unprotecting a protected branch requires admin", () => {
  const repo = manager();
  repo.setRole("main", "bob", "maintain");
  assert.throws(
    () => repo.setProtection("main", false, maintainer),
    /unprotecting main requires admin/
  );
  assert.equal(repo.getBranch("main")?.protected, true);
  assert.equal(repo.setProtection("main", false, admin).protected, false);
  assert.equal(repo.setProtection("main", true, admin).protected, true);
});

test("protected branches can only be deleted by an admin", () => {
  const repo = manager();
  const branch = repo.createBranch({ name: "release", actor: admin, protected: true });
  repo.setRole("release", "bob", "maintain");
  repo.setRole("release", "carol", "write");

  assert.throws(() => repo.deleteBranch(branch.name, writer), /delete requires admin/);
  assert.throws(() => repo.deleteBranch(branch.name, maintainer), /delete requires admin/);
  assert.equal(repo.deleteBranch(branch.name, admin, { force: true }), true);
});

test("deleting a branch with unmerged commits requires force", () => {
  const repo = manager();
  commitOn(repo, "main", [set("evt-1", "a", "1")]);
  repo.createBranch({ name: "feature", from: "main", actor: admin });
  commitOn(repo, "feature", [set("evt-1", "a", "2")]);

  assert.throws(
    () => repo.deleteBranch("feature", maintainer),
    (error: unknown) => error instanceof BranchError && error.code === "branch-not-empty"
  );
  assert.equal(repo.deleteBranch("feature", maintainer, { force: true }), true);
  assert.equal(repo.getBranch("feature"), undefined);
});

test("a fully merged branch deletes without force", () => {
  const repo = manager();
  commitOn(repo, "main", [set("evt-1", "a", "1")]);
  repo.createBranch({ name: "feature", from: "main", actor: admin });
  commitOn(repo, "feature", [set("evt-1", "a", "2")]);
  repo.merge("feature", "main", { actor: admin });

  assert.equal(repo.deleteBranch("feature", maintainer), true);
});

test("deniedActions lists what an actor cannot do", () => {
  const repo = manager();
  repo.setRole("main", "carol", "write");
  const branch = repo.getBranch("main");
  assert.equal(branch !== undefined, true);
  const denied = deniedActions(roleTable(repo, "main"), branch as never, writer);
  assert.equal(denied.includes("commit"), true, "main is protected so write cannot commit");
  assert.equal(denied.includes("read"), false);
  assert.equal(denied.includes("protect"), true);
  assert.deepEqual(repo.rolesFor("main"), { carol: "write" });
});

test("merge primitives work on a bare commit map", () => {
  const repo = manager();
  const base = commitOn(repo, "main", [set("evt-1", "a", "1")]);
  repo.createBranch({ name: "feature", from: "main", actor: admin });
  const left = commitOn(repo, "main", [set("evt-1", "a", "2")]);
  const right = commitOn(repo, "feature", [set("evt-1", "a", "3")]);
  const commits = commitMap(repo);

  assert.deepEqual(ancestorsOf(commits, right.id), [right.id, base.id]);
  assert.equal(isAncestor(commits, base.id, left.id), true);
  assert.equal(isAncestor(commits, left.id, right.id), false);
  assert.equal(isAncestor(commits, null, right.id), true);
  assert.equal(findMergeBase(commits, left.id, right.id), base.id);
  assert.equal(findMergeBase(commits, left.id, "missing"), null);
  assert.equal(repo.mergeBase("main", "feature"), base.id);

  const snapshot = replay(commits, base.id, left.id);
  const snapshotKey = changeKey(set("evt-1", "a", "2"));
  assert.equal((snapshot.get(snapshotKey) as FieldState).value, "2");
  assert.equal(replay(commits, base.id, base.id).size, 0);
});

test("stateAfter, toChange, and detectConflicts behave as documented", () => {
  const fieldA = changeKey(set("evt-1", "a", 1));
  const fieldB = changeKey(set("evt-1", "b", 1));
  const start = new Map<string, FieldState>([[fieldA, { present: true, value: 1 }]]);
  const next = stateAfter(start, [
    set("evt-1", "a", 2),
    { resourceId: "evt-1", field: "b", op: "delete" },
  ]);
  assert.equal((next.get(fieldA) as FieldState).value, 2);
  assert.deepEqual(next.get(fieldB), { present: false });
  assert.deepEqual(toChange("evt-1", "b", { present: false }), {
    resourceId: "evt-1",
    field: "b",
    op: "delete",
  });
  assert.deepEqual(toChange("evt-1", "a", { present: true, value: 1 }), {
    resourceId: "evt-1",
    field: "a",
    op: "set",
    value: 1,
  });

  const base = new Map<string, FieldState>([[fieldA, { present: true, value: 1 }]]);
  const ours = new Map<string, FieldState>([[fieldA, { present: true, value: 2 }]]);
  const theirs = new Map<string, FieldState>([[fieldA, { present: true, value: 3 }]]);
  assert.equal(detectConflicts(base, ours, theirs).length, 1);
  assert.equal(detectConflicts(base, ours, ours).length, 0);
  assert.equal(detectConflicts(base, base, ours).length, 0);
});

test("assertCan throws a coded error for an action the role lacks", () => {
  const roles = new Map([["main", new Map([["dave", "read" as const]])]]);
  const branch = {
    name: "main",
    head: null,
    createdAt: 0,
    createdBy: "system",
    protected: false,
    allowNonFastForward: true,
  };
  assert.throws(
    () => assertCan(roles, branch, { id: "dave" }, "commit"),
    (error: unknown) => error instanceof BranchError && error.code === "permission-denied"
  );
});
