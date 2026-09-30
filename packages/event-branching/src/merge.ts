/**
 * Three-way merge of contract event changes (#429)
 *
 * The merge replays both sides over their common ancestor and compares the
 * resulting field states. A field changed on one side only is taken from that
 * side; a field changed identically on both is taken once; a field changed
 * differently on both is a conflict for a human to resolve.
 */

import type { Commit, Conflict, EventChange, FieldState } from "./types.ts";

/**
 * Separator between a resource id and a field name in a flat snapshot key.
 * Built from its code point so no control character is embedded in the source,
 * and chosen so it cannot collide with either part of a key.
 */
export const FIELD_SEPARATOR = String.fromCharCode(31);

/** Composite key for a single field of a single resource. */
export function changeKey(change: EventChange): string {
  return `${change.resourceId}${FIELD_SEPARATOR}${change.field}`;
}

export function parseKey(key: string): { resourceId: string; field: string } {
  const [resourceId, field] = key.split(FIELD_SEPARATOR);
  return { resourceId, field };
}

/** Reads the state of every field touched by a commit, relative to its parents. */
export function stateAfter(
  snapshot: Map<string, FieldState>,
  changes: EventChange[]
): Map<string, FieldState> {
  const next = new Map(snapshot);
  for (const change of changes) {
    const key = changeKey(change);
    if (change.op === "delete") next.set(key, { present: false });
    else next.set(key, { present: true, value: change.value });
  }
  return next;
}

function sameState(a: FieldState, b: FieldState): boolean {
  if (a.present !== b.present) return false;
  if (!a.present) return true;
  return JSON.stringify(a.value ?? null) === JSON.stringify(b.value ?? null);
}

const ABSENT: FieldState = { present: false };

/** Fields the two sides touched differently and therefore disagree on. */
export function detectConflicts(
  base: Map<string, FieldState>,
  ours: Map<string, FieldState>,
  theirs: Map<string, FieldState>
): Conflict[] {
  const keys = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const conflicts: Conflict[] = [];

  for (const key of keys) {
    const baseState = base.get(key) ?? ABSENT;
    const ourState = ours.get(key) ?? ABSENT;
    const theirState = theirs.get(key) ?? ABSENT;

    const weChanged = !sameState(ourState, baseState);
    const theyChanged = !sameState(theirState, baseState);

    if (!weChanged && !theyChanged) continue;
    if (weChanged && !theyChanged) continue;
    if (!weChanged && theyChanged) continue;
    if (sameState(ourState, theirState)) continue;

    const { resourceId, field } = parseKey(key);
    conflicts.push({ resourceId, field, base: baseState, ours: ourState, theirs: theirState });
  }
  return conflicts.sort((a, b) => (a.resourceId === b.resourceId
    ? a.field < b.field
      ? -1
      : a.field > b.field
        ? 1
        : 0
    : a.resourceId < b.resourceId
      ? -1
      : 1));
}

/** Turns a resolved field state back into the change that produces it. */
export function toChange(resourceId: string, field: string, state: FieldState): EventChange | null {
  if (!state.present) return { resourceId, field, op: "delete" };
  return { resourceId, field, op: "set", value: state.value };
}

/** Changes made on `side` that the other side neither made nor contradicted. */
export function incomingChanges(
  side: Map<string, FieldState>,
  other: Map<string, FieldState>,
  base: Map<string, FieldState>
): EventChange[] {
  const changes: EventChange[] = [];
  for (const [key, state] of side) {
    const baseState = base.get(key) ?? ABSENT;
    if (sameState(state, baseState)) continue;
    if (sameState(state, other.get(key) ?? ABSENT)) continue;
    const { resourceId, field } = parseKey(key);
    const change = toChange(resourceId, field, state);
    if (change) changes.push(change);
  }
  return changes.sort((a, b) => (changeKey(a) < changeKey(b) ? -1 : changeKey(a) > changeKey(b) ? 1 : 0));
}

/** Commits reachable from `commitId`, newest first. */
export function ancestorsOf(commits: Map<string, Commit>, commitId: string | null): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const stack = commitId === null ? [] : [commitId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    if (!commits.has(current)) continue;
    seen.add(current);
    ordered.push(current);
    for (const parent of commits.get(current)?.parents ?? []) stack.push(parent);
  }
  return ordered;
}

/** True when `candidate` is an ancestor of `descendant` (or the same commit). */
export function isAncestor(
  commits: Map<string, Commit>,
  candidate: string | null,
  descendant: string | null
): boolean {
  if (candidate === null) return true;
  return ancestorsOf(commits, descendant).includes(candidate);
}

/**
 * Best common ancestor of two commits: the closest commit reachable from both.
 * Ties resolve to the most recently created, so the merge is as narrow as
 * possible.
 */
export function findMergeBase(
  commits: Map<string, Commit>,
  left: string | null,
  right: string | null
): string | null {
  if (left === null || right === null) return null;
  const rightAncestors = new Set(ancestorsOf(commits, right));
  const shared = ancestorsOf(commits, left).filter((id) => rightAncestors.has(id));
  if (shared.length === 0) return null;
  shared.sort((a, b) => {
    const timeDelta = (commits.get(b)?.timestamp ?? 0) - (commits.get(a)?.timestamp ?? 0);
    return timeDelta !== 0 ? timeDelta : a < b ? -1 : 1;
  });
  return shared[0];
}

/** Replays the commits reachable from `toCommit` but not from `fromCommit`. */
export function replay(
  commits: Map<string, Commit>,
  fromCommit: string | null,
  toCommit: string | null
): Map<string, FieldState> {
  if (toCommit === null) return new Map();
  const base = new Set(ancestorsOf(commits, fromCommit));
  const ordered: Commit[] = [];
  const visited = new Set<string>();
  const expanding = new Set<string>();
  const stack: string[] = [toCommit];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (visited.has(current)) continue;
    const commit = commits.get(current);
    if (!commit) continue;
    if (expanding.has(current)) {
      expanding.delete(current);
      if (!base.has(current)) {
        visited.add(current);
        ordered.push(commit);
      }
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
    snapshot = stateAfter(snapshot, commit.changes);
  }
  return snapshot;
}
