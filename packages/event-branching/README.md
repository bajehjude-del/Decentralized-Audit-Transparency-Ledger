# event-branching

Git-style branching for contract event streams. Branches, commits, and merges
for event records without a database or runtime dependencies.

## What it does

- **Branches** - create branches from any branch head or commit, list and
  delete them, protect them, and mark them fast-forward-only.
- **Commits** - a commit is a set of field changes applied to one branch head,
  threaded through the DAG with parents.
- **Merges** - fast-forward merges, three-way merges over resolved field state,
  and merges that reject divergent history.
- **Conflicts** - a field changed differently on both sides is reported as a
  conflict, resolvable automatically (`ours`/`theirs`) or parked as a manual
  merge to finish with `resolve()`.
- **Permissions** - a role hierarchy (`read`, `write`, `maintain`, `admin`)
  with branch grants, repository-wide grants, and wildcard defaults. Protected
  branches escalate `commit` to `maintain` and `delete-branch` to `admin`.

## Usage

```ts
import { EventBranchManager } from "./src/index.ts";

const repo = new EventBranchManager();
const base = repo.commit("main", {
  author: "dev",
  message: "seed",
  changes: [{ resourceId: "evt-1", field: "status", op: "set", value: "open" }],
}, { id: "alice", role: "admin" });

repo.createBranch({ name: "feature/kyc", from: "main", actor: { id: "alice", role: "admin" } });
repo.commit("feature/kyc", {
  author: "dev",
  message: "triage",
  changes: [{ resourceId: "evt-1", field: "severity", op: "set", value: "high" }],
}, { id: "alice", role: "admin" });

const outcome = repo.merge("feature/kyc", "main", { actor: { id: "alice", role: "admin" } });
if (outcome.status === "conflicted") {
  // resolve() completes a parked manual merge
  repo.resolve(repo.pendingMerges()[0].id, { "evt-1.status": "theirs" }, { actor: { id: "bob", role: "maintain" } });
}
```

## Merge model

Each commit records only its own changes. The state of a resource is replayed
from the commit DAG, so merging compares two sides against their common base:

- changed on one side only -> taken from that side
- changed identically on both sides -> taken once
- changed differently on both sides -> a conflict

## Testing

```sh
node --experimental-strip-types --test test/*.test.ts
```

Requires Node 22.6+ (type stripping). No dependencies.