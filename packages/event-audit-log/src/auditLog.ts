/**
 * Contract event audit log (#428)
 *
 * Records every contract operation into a hash-chained log, answers structured
 * queries, exports in SIEM dialects, and drives long-term retention.
 */

import { formatEntries } from "./formats.ts";
import { HashChain, GENESIS_HASH } from "./hashChain.ts";
import {
  applyTierTransitions,
  assertMutable,
  planPurge,
  planTierTransitions,
  retentionDeadline,
  tierCounts,
  tierForAge,
} from "./retention.ts";
import type { TierTransition } from "./retention.ts";
import { DEFAULT_RETENTION_POLICY } from "./types.ts";
import type {
  AuditEntry,
  AuditFormat,
  AuditInput,
  AuditQuery,
  AuditRecord,
  AuditSeverity,
  ComplianceReport,
  FlushResult,
  IntegrityReport,
  RetentionPolicy,
  RetentionTier,
} from "./types.ts";

const DEFAULT_SEVERITY: Record<AuditOutcome, AuditSeverity> = {
  success: "info",
  failure: "medium",
  denied: "high",
};

export interface AuditLogOptions {
  retention?: RetentionPolicy;
  /** Anchor the chain to a previously published head for cross-run continuity. */
  genesisHash?: string;
  now?: () => number;
}

export interface AuditStats {
  total: number;
  sealed: number;
  byTier: Record<RetentionTier, number>;
  headHash: string;
  valid: boolean;
}

export class AuditLog {
  private readonly chain: HashChain;
  private readonly policy: RetentionPolicy;
  private readonly now: () => number;
  private sequence = 0;

  constructor(options: AuditLogOptions = {}) {
    this.policy = options.retention ?? DEFAULT_RETENTION_POLICY;
    this.now = options.now ?? (() => Date.now());
    this.chain = new HashChain({
      genesisHash: options.genesisHash ?? GENESIS_HASH,
      decorate: (entry) => {
        const rule = tierForAge(this.policy, 0);
        return { tier: rule.tier, sealed: rule.immutable, ...entry };
      },
    });
  }

  /** Appends one contract operation to the log. */
  record(input: AuditInput): AuditEntry {
    if (!input.action) throw new Error("audit action is required");
    if (!input.actor?.id) throw new Error("audit actor id is required");
    if (!input.resource?.id) throw new Error("audit resource id is required");

    const timestamp = input.timestamp ?? this.now();
    this.sequence += 1;
    const record: AuditRecord = {
      sequence: this.sequence,
      timestamp,
      timestampIso: new Date(timestamp).toISOString(),
      action: input.action,
      outcome: input.outcome,
      severity: input.severity ?? DEFAULT_SEVERITY[input.outcome] ?? "info",
      actor: input.actor,
      resource: input.resource,
      contractId: input.contractId ?? input.resource.contractId,
      eventId: input.eventId,
      ledgerSequence: input.ledgerSequence,
      detail: input.detail,
      correlationId: input.correlationId,
      outcomeReason: input.outcomeReason,
      tags: input.tags,
    };
    return this.chain.append(record);
  }

  /** Records many operations in order. */
  recordAll(inputs: AuditInput[]): AuditEntry[] {
    return inputs.map((input) => this.record(input));
  }

  /** Every entry, oldest first. */
  entries(): AuditEntry[] {
    return this.chain.all();
  }

  /** The most recent entries, newest first. */
  tail(limit = 10): AuditEntry[] {
    return this.chain.all().slice(-limit).reverse();
  }

  get head(): string {
    return this.chain.head();
  }

  get length(): number {
    return this.chain.length;
  }

  getPolicy(): RetentionPolicy {
    return { ...this.policy, rules: this.policy.rules.map((rule) => ({ ...rule })) };
  }

  /**
   * Verifies the hash chain; the result is compliance evidence. Pass
   * `expectedHead` to also check the log against an externally published head.
   */
  verify(options: { now?: number; expectedHead?: string } = {}): IntegrityReport {
    return this.chain.verify({ now: this.now(), ...options });
  }

  /** Structured query over the chain. Filters compose with AND. */
  query(filter: AuditQuery = {}): AuditEntry[] {
    const results = this.chain.all().filter((entry) => {
      if (filter.action !== undefined && entry.action !== filter.action) return false;
      if (filter.actorId !== undefined && entry.actor.id !== filter.actorId) return false;
      if (filter.outcome !== undefined && entry.outcome !== filter.outcome) return false;
      if (filter.severity !== undefined && entry.severity !== filter.severity) return false;
      if (filter.contractId !== undefined && entry.contractId !== filter.contractId) return false;
      if (filter.eventId !== undefined && entry.eventId !== filter.eventId) return false;
      if (filter.correlationId !== undefined && entry.correlationId !== filter.correlationId) return false;
      if (filter.from !== undefined && entry.timestamp < filter.from) return false;
      if (filter.to !== undefined && entry.timestamp > filter.to) return false;
      return true;
    });
    return filter.limit === undefined ? results : results.slice(-filter.limit);
  }

  /** Encodes a query result in the requested format. */
  export(filter: AuditQuery, format: AuditFormat = "ndjson"): string {
    return formatEntries(this.query(filter), format);
  }

  /**
   * Promotes entries to the tier their age calls for and seals the immutable
   * ones. Returns the transitions that were applied.
   *
   * `tier` and `sealed` are deliberately outside the hashed record body, so
   * moving an entry between tiers never invalidates the chain.
   */
  applyRetention(now: number = this.now()): TierTransition[] {
    const transitions = planTierTransitions(this.chain.all(), this.policy, now);
    if (transitions.length === 0) return transitions;
    const current = this.chain.all();
    const updated = applyTierTransitions(current, this.policy, now);
    for (let index = 0; index < current.length; index += 1) {
      current[index].tier = updated[index].tier;
      current[index].sealed = updated[index].sealed;
    }
    return transitions;
  }

  /** Throws when the entry is sealed in a write-once policy. */
  assertEditable(entry: AuditEntry): void {
    assertMutable(entry, this.policy);
  }

  /** Earliest instant at which any entry may be destroyed. */
  retentionDeadline(): number | null {
    return retentionDeadline(this.chain.all(), this.policy);
  }

  /** Per-entry purge decisions under the retention policy. */
  planPurge(now: number = this.now()) {
    return planPurge(this.chain.all(), now, this.policy);
  }

  /** Ships entries to a SIEM sink, oldest first, without removing them locally. */
  async ship(sink: { enqueueAll(entries: AuditEntry[]): Promise<FlushResult | null> }, filter: AuditQuery = {}): Promise<FlushResult | null> {
    return sink.enqueueAll(this.query(filter));
  }

  stats(): AuditStats {
    const entries = this.chain.all();
    return {
      total: entries.length,
      sealed: entries.filter((entry) => entry.sealed).length,
      byTier: tierCounts(entries),
      headHash: this.chain.head(),
      valid: this.chain.verify({ now: this.now() }).valid,
    };
  }

  /** Aggregates a window into a compliance report. */
  report(
    framework: ComplianceReport["framework"],
    period: { from: number; to: number },
    controls: ComplianceReport["controls"]
  ): ComplianceReport {
    const entries = this.query({ from: period.from, to: period.to });
    const integrity = this.verify();
    const byAction: Record<string, number> = {};
    const byOutcome: ComplianceReport["byOutcome"] = { success: 0, failure: 0, denied: 0 };
    const bySeverity: Record<AuditSeverity, number> = {
      info: 0,
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };
    const actors = new Map<string, { records: number; failures: number; denials: number }>();

    for (const entry of entries) {
      byAction[entry.action] = (byAction[entry.action] ?? 0) + 1;
      byOutcome[entry.outcome] += 1;
      bySeverity[entry.severity] += 1;
      const actor = actors.get(entry.actor.id) ?? { records: 0, failures: 0, denials: 0 };
      actor.records += 1;
      if (entry.outcome === "failure") actor.failures += 1;
      if (entry.outcome === "denied") actor.denials += 1;
      actors.set(entry.actor.id, actor);
    }

    const evaluated = controls.map((control) => {
      const satisfied = integrity.valid;
      const evidence = satisfied
        ? `hash chain verified across ${integrity.entries} entries, head ${integrity.headHash}`
        : `integrity check failed with ${integrity.issues.length} issue(s)`;
      return { ...control, satisfied, evidence };
    });

    return {
      framework,
      generatedAt: this.now(),
      period,
      totalRecords: entries.length,
      byAction,
      byOutcome,
      bySeverity,
      byTier: tierCounts(entries),
      topActors: [...actors.entries()]
        .map(([actorId, stats]) => ({ actorId, ...stats }))
        .sort((a, b) => b.records - a.records)
        .slice(0, 10),
      integrity,
      controls: evaluated,
      retentionDeadline: this.retentionDeadline(),
    };
  }
}
