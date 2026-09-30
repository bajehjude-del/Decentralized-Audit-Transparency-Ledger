/**
 * Compaction policies for contract event storage (#427)
 *
 * A policy is a pure, declarative description of what may be removed. The
 * compactor evaluates every stored event against the policy and records the
 * outcome, so a pass is always explainable and auditable.
 */

import type { ProtectionReason, StoredEvent } from "./types.ts";

export interface CompactionPolicy {
  /**
   * How many of the most recent versions to keep per
   * (contractId, eventType) key. Everything older is superseded.
   */
  retainVersions: number;
  /** Compact events whose timestamp is older than this. Omit to disable. */
  maxAgeMs?: number;
  /** Never remove events flagged `immutable` (on-chain sealed). */
  protectImmutable: boolean;
  /** Never remove events flagged `sealed` (archived buckets). */
  protectSealed: boolean;
  /** Never remove events flagged `legalHold`. */
  honorLegalHold: boolean;
  /** Remove events whose `parentEventId` no longer resolves. */
  collectOrphans: boolean;
  /** Remove segments that hold no remaining events. */
  collectUnreferencedSegments: boolean;
  /** Skip the pass entirely when reclaim would be below this many bytes. */
  minReclaimBytes: number;
  /** Restrict the pass to these contracts. Empty or omitted means all. */
  contracts?: string[];
}

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  retainVersions: 5,
  maxAgeMs: 365 * 24 * 60 * 60 * 1000,
  protectImmutable: true,
  protectSealed: true,
  honorLegalHold: true,
  collectOrphans: true,
  collectUnreferencedSegments: true,
  minReclaimBytes: 0,
};

/** Identity of a versioned entity: versions of different keys never supersede. */
export function eventKey(event: StoredEvent): string {
  return `${event.contractId}::${event.eventType}`;
}

/** Stable ordering used to decide which versions are the newest. */
export function compareVersions(a: StoredEvent, b: StoredEvent): number {
  if (a.version !== b.version) return a.version - b.version;
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Returns the protection that applies to an event, or `null` when the policy
 * allows the event to be considered for removal.
 */
export function findProtection(
  event: StoredEvent,
  policy: CompactionPolicy
): ProtectionReason | null {
  if (policy.honorLegalHold && event.legalHold) return "legal-hold";
  if (policy.protectImmutable && event.immutable) return "immutable";
  if (policy.protectSealed && event.sealed) return "sealed";
  return null;
}

/**
 * Groups events by version key and returns the ids that are superseded, i.e.
 * every version outside the newest `retainVersions` window. The newest versions
 * themselves are reported as skipped with reason `retained-head`.
 */
export function selectSuperseded(
  events: StoredEvent[],
  policy: CompactionPolicy
): { superseded: StoredEvent[]; retained: StoredEvent[] } {
  const byKey = new Map<string, StoredEvent[]>();
  for (const event of events) {
    const key = eventKey(event);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(event);
    else byKey.set(key, [event]);
  }

  const superseded: StoredEvent[] = [];
  const retained: StoredEvent[] = [];
  for (const bucket of byKey.values()) {
    const ordered = [...bucket].sort(compareVersions);
    const keepFrom = Math.max(0, ordered.length - policy.retainVersions);
    for (let index = 0; index < ordered.length; index += 1) {
      if (index < keepFrom) superseded.push(ordered[index]);
      else retained.push(ordered[index]);
    }
  }
  return { superseded, retained };
}

/** Returns the events whose timestamp falls before `now - policy.maxAgeMs`. */
export function selectExpired(
  events: StoredEvent[],
  policy: CompactionPolicy,
  now: number
): StoredEvent[] {
  if (policy.maxAgeMs === undefined) return [];
  const cutoff = now - policy.maxAgeMs;
  return events.filter((event) => event.timestamp < cutoff);
}

/**
 * Returns events that reference a `parentEventId` which no longer resolves.
 * Only dangling parents count: a live chain is not garbage.
 */
export function selectOrphans(
  events: StoredEvent[],
  existingIds: ReadonlySet<string>
): StoredEvent[] {
  return events.filter(
    (event) =>
      event.parentEventId !== undefined && !existingIds.has(event.parentEventId)
  );
}

/** True when the event's contract is inside the policy scope. */
export function inScope(
  event: StoredEvent,
  policy: CompactionPolicy
): boolean {
  if (!policy.contracts || policy.contracts.length === 0) return true;
  return policy.contracts.includes(event.contractId);
}

/**
 * Returns the segments that hold no events left in the store, which is the
 * normal end state of a compaction pass over a segment-backed store.
 */
export function selectUnreferencedSegments(
  segments: Array<{ id: string; eventIds: string[] }>,
  remainingIds: ReadonlySet<string>
): string[] {
  return segments.filter((segment) => !segment.eventIds.some((id) => remainingIds.has(id))).map(
    (segment) => segment.id
  );
}
