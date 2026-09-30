/**
 * Contract event compactor and garbage collector (#427)
 *
 * One pass evaluates every stored event against the policy, unions the removal
 * candidates, deletes them, and releases any segment left empty. Candidates are
 * unioned (not applied in sequence) so a dry run reports exactly what a real run
 * would remove.
 */

import { randomUUID } from "node:crypto";

import {
  DEFAULT_COMPACTION_POLICY,
  eventKey,
  findProtection,
  inScope,
  selectExpired,
  selectOrphans,
  selectSuperseded,
  selectUnreferencedSegments,
} from "./policy.ts";
import type { CompactionPolicy } from "./policy.ts";
import type { EventStore } from "./store.ts";
import type {
  CompactionReason,
  CompactionResult,
  CompactionSkip,
  StoredEvent,
} from "./types.ts";

export interface CompactOptions {
  /** Overrides the clock, for deterministic tests and backfills. */
  now?: number;
  /** Report what would be removed without mutating the store. */
  dryRun?: boolean;
}

interface Candidate {
  event: StoredEvent;
  reason: CompactionReason;
}

/**
 * Removal reason priority. An event that is both expired and orphaned is
 * reported once, using the most descriptive reason available.
 */
const REASON_PRIORITY: CompactionReason[] = [
  "orphaned",
  "superseded",
  "ttl-expired",
];

export class EventCompactor {
  private readonly store: EventStore;
  private readonly policy: CompactionPolicy;
  private runCounter = 0;

  constructor(store: EventStore, policy: Partial<typeof DEFAULT_COMPACTION_POLICY> = {}) {
    this.store = store;
    this.policy = { ...DEFAULT_COMPACTION_POLICY, ...policy };
  }

  /** The resolved policy, including defaults. */
  getPolicy(): CompactionPolicy {
    return { ...this.policy };
  }

  /**
   * Byte count a pass would reclaim, without touching the store. Useful for
   * deciding whether the pass is worth the I/O.
   */
  estimateReclaimableBytes(now: number = Date.now()): number {
    return this.plan(now).candidates.reduce((total, candidate) => total + candidate.event.bytes, 0);
  }

  /** Runs one compaction and garbage collection pass. */
  compact(options: CompactOptions = {}): CompactionResult {
    const startedAt = Date.now();
    const now = options.now ?? startedAt;
    const dryRun = options.dryRun ?? false;
    this.runCounter += 1;
    const runId = `cmp-${now.toString(36)}-${this.runCounter.toString().padStart(4, "0")}`;

    const errors: string[] = [];
    const plan = this.plan(now);
    const skipped: CompactionSkip[] = plan.skipped;

    const compacted = plan.candidates.map((candidate) => ({
      id: candidate.event.id,
      reason: candidate.reason,
      bytes: candidate.event.bytes,
    }));
    const reclaimedBytes = compacted.reduce((total, entry) => total + entry.bytes, 0);

    let freedSegments: string[] = [];
    if (!dryRun) {
      if (plan.candidates.length > 0) {
        try {
          this.store.removeEvents(plan.candidates.map((candidate) => candidate.event.id));
        } catch (error) {
          errors.push(`event removal failed: ${describe(error)}`);
        }
      }
      if (this.policy.collectUnreferencedSegments) {
        try {
          freedSegments = this.releaseEmptySegments();
        } catch (error) {
          errors.push(`segment release failed: ${describe(error)}`);
        }
      }
    } else if (this.policy.collectUnreferencedSegments) {
      const remaining = this.remainingIds(plan.removedIds);
      freedSegments = selectUnreferencedSegments(
        this.store.listSegments().map((segment) => ({ id: segment.id, eventIds: segment.eventIds })),
        remaining
      );
    }

    const completedAt = Date.now();
    return {
      runId,
      startedAt,
      completedAt,
      dryRun,
      compacted,
      compactedIds: compacted.map((entry) => entry.id),
      freedSegments,
      reclaimedBytes,
      skipped,
      errors,
      durationMs: completedAt - startedAt,
    };
  }

  /**
   * Evaluates the policy over the whole store. Exposed for dry-run inspection
   * and for the scheduler's monitoring snapshot.
   */
  plan(now: number = Date.now()): {
    candidates: Candidate[];
    removedIds: Set<string>;
    skipped: CompactionSkip[];
  } {
    const allEvents = this.store.listEvents();
    const inScopeEvents = allEvents.filter((event) => inScope(event, this.policy));
    const outOfScope = allEvents.filter((event) => !inScope(event, this.policy));

    const scopedIds = new Set(inScopeEvents.map((event) => event.id));
    const allIds = new Set(allEvents.map((event) => event.id));

    const { superseded, retained } = selectSuperseded(inScopeEvents, this.policy);
    const expired = selectExpired(inScopeEvents, this.policy, now);
    const orphans = this.policy.collectOrphans
      ? selectOrphans(inScopeEvents, allIds)
      : [];

    const reasons = new Map<string, CompactionReason>();
    const push = (events: StoredEvent[], reason: CompactionReason): void => {
      for (const event of events) {
        if (!reasons.has(event.id)) reasons.set(event.id, reason);
      }
    };
    push(orphans, "orphaned");
    push(superseded, "superseded");
    push(expired, "ttl-expired");

    const skipped: CompactionSkip[] = [];
    const seenSkip = new Set<string>();
    const skip = (event: StoredEvent, reason: CompactionSkip["reason"]): void => {
      if (seenSkip.has(event.id)) return;
      seenSkip.add(event.id);
      skipped.push({ id: event.id, reason });
    };
    // Protections and scope are absolute: they veto any reason above.
    for (const event of inScopeEvents) {
      const protection = findProtection(event, this.policy);
      if (protection) skip(event, protection);
    }
    for (const event of outOfScope) skip(event, "out-of-scope");

    const candidates: Candidate[] = [];
    for (const [id, reason] of reasons) {
      if (seenSkip.has(id)) continue;
      const event = this.store.getEvent(id);
      if (!event || !scopedIds.has(id)) continue;
      candidates.push({ event, reason });
    }
    candidates.sort(
      (a, b) => REASON_PRIORITY.indexOf(a.reason) - REASON_PRIORITY.indexOf(b.reason)
    );

    // A retained head is only news when nothing else claimed the event: a
    // retained head that is expired or orphaned is still compacted.
    for (const event of retained) {
      if (!reasons.has(event.id)) skip(event, "retained-head");
    }

    return { candidates, removedIds: new Set(candidates.map((c) => c.event.id)), skipped };
  }

  /**
   * The current head event for each in-scope version key, i.e. the survivors a
   * reader will still see after compaction.
   */
  latestVersions(): StoredEvent[] {
    const { retained } = selectSuperseded(
      this.store.listEvents().filter((event) => inScope(event, this.policy)),
      this.policy
    );
    const byKey = new Map<string, StoredEvent>();
    for (const event of retained) {
      const key = eventKey(event);
      const current = byKey.get(key);
      if (!current || current.version < event.version) byKey.set(key, event);
    }
    return [...byKey.values()];
  }

  private remainingIds(plannedRemovals: ReadonlySet<string>): Set<string> {
    const remaining = new Set<string>();
    for (const event of this.store.listEvents()) {
      if (!plannedRemovals.has(event.id)) remaining.add(event.id);
    }
    return remaining;
  }

  private releaseEmptySegments(): string[] {
    const remaining = this.remainingIds(new Set());
    const empty = selectUnreferencedSegments(
      this.store.listSegments().map((segment) => ({ id: segment.id, eventIds: segment.eventIds })),
      remaining
    );
    if (empty.length === 0) return [];
    this.store.removeSegments(empty);
    return empty;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
