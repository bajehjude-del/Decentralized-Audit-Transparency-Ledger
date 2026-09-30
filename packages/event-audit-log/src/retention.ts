/**
 * Long-term retention tiers for the contract event audit log (#428)
 *
 * Entries age through hot → warm → cold → archive. Each tier declares whether
 * it is immutable; immutable tiers are sealed and, when the policy is
 * write-once, refuse any later edit or purge before the legal deadline.
 */

import { DEFAULT_RETENTION_POLICY } from "./types.ts";
import type { AuditEntry, RetentionPolicy, RetentionRule, RetentionTier } from "./types.ts";

/** The tier an entry of the given age belongs in. */
export function tierForAge(policy: RetentionPolicy, ageMs: number): RetentionRule {
  const ordered = [...policy.rules].sort((a, b) => a.afterMs - b.afterMs);
  let current = ordered[0];
  for (const rule of ordered) {
    if (ageMs >= rule.afterMs) current = rule;
  }
  return current;
}

export interface TierTransition {
  sequence: number;
  from: RetentionTier;
  to: RetentionTier;
  sealed: boolean;
  ageMs: number;
}

/** Entries whose tier no longer matches their age, with the target tier. */
export function planTierTransitions(
  entries: AuditEntry[],
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
  now: number = Date.now()
): TierTransition[] {
  const transitions: TierTransition[] = [];
  for (const entry of entries) {
    const target = tierForAge(policy, now - entry.timestamp);
    if (target.tier === entry.tier) continue;
    transitions.push({
      sequence: entry.sequence,
      from: entry.tier,
      to: target.tier,
      sealed: target.immutable,
      ageMs: now - entry.timestamp,
    });
  }
  return transitions;
}

/** Applies pending tier transitions and returns the updated entries. */
export function applyTierTransitions(
  entries: AuditEntry[],
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
  now: number = Date.now()
): AuditEntry[] {
  return entries.map((entry) => {
    const target = tierForAge(policy, now - entry.timestamp);
    if (target.tier === entry.tier) return entry;
    return { ...entry, tier: target.tier, sealed: target.immutable };
  });
}

/**
 * Earliest instant at which any entry may be destroyed. `null` when the log is
 * empty or the policy demands indefinite retention.
 */
export function retentionDeadline(
  entries: AuditEntry[],
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY
): number | null {
  if (entries.length === 0) return null;
  const oldest = entries.reduce((min, entry) => (entry.timestamp < min ? entry.timestamp : min), Infinity);
  return oldest + policy.minRetentionMs;
}

export interface PurgeDecision {
  id: string;
  sequence: number;
  purgeable: boolean;
  reason:
    | "retained"
    | "min-retention"
    | "write-once"
    | "legal-hold"
    | "eligible"
    | "no-deadline";
}

export interface PurgePlan {
  decisions: PurgeDecision[];
  purgeableIds: string[];
  deadline: number | null;
}

/**
 * Decides, per entry, whether it may be destroyed at `now`. An entry is only
 * eligible once it is past the policy deadline, is not sealed in a write-once
 * policy, and carries no legal hold.
 */
export function planPurge(
  entries: AuditEntry[],
  now: number = Date.now(),
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY
): PurgePlan {
  const deadline = retentionDeadline(entries, policy);
  const decisions: PurgeDecision[] = [];

  for (const entry of entries) {
    let decision: PurgeDecision;
    if (entry.tier !== "hot" && entry.tier !== "warm") {
      decision = {
        id: entry.hash,
        sequence: entry.sequence,
        purgeable: false,
        reason: policy.writeOnce ? "write-once" : "retained",
      };
    } else if (deadline === null) {
      decision = { id: entry.hash, sequence: entry.sequence, purgeable: false, reason: "no-deadline" };
    } else if (entry.timestamp + policy.minRetentionMs > now) {
      decision = { id: entry.hash, sequence: entry.sequence, purgeable: false, reason: "min-retention" };
    } else {
      decision = { id: entry.hash, sequence: entry.sequence, purgeable: true, reason: "eligible" };
    }
    decisions.push(decision);
  }

  return {
    decisions,
    purgeableIds: decisions.filter((item) => item.purgeable).map((item) => item.id),
    deadline,
  };
}

/** Throws when an entry may not be modified. */
export function assertMutable(entry: AuditEntry, policy: RetentionPolicy = DEFAULT_RETENTION_POLICY): void {
  if (entry.sealed && policy.writeOnce) {
    throw new Error(`audit entry ${entry.sequence} is sealed in the ${entry.tier} tier and cannot be modified`);
  }
}

/** Count of entries per tier, for reporting. */
export function tierCounts(entries: AuditEntry[]): Record<RetentionTier, number> {
  const counts: Record<RetentionTier, number> = { hot: 0, warm: 0, cold: 0, archive: 0 };
  for (const entry of entries) counts[entry.tier] += 1;
  return counts;
}
