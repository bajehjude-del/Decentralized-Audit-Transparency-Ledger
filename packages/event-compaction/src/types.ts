/**
 * Contract event compaction and garbage collection types (#427)
 */

/** Why a stored event (or segment) was selected for removal. */
export type CompactionReason =
  | "superseded"
  | "ttl-expired"
  | "orphaned"
  | "unreferenced-segment";

/** Why an otherwise eligible event was left untouched. */
export type ProtectionReason = "immutable" | "sealed" | "legal-hold" | "retained-head";

/** A contract event as persisted by the ledger, in the shape compaction needs. */
export interface StoredEvent {
  id: string;
  contractId: string;
  eventType: string;
  /** Monotonic per-version counter; higher versions supersede lower ones. */
  version: number;
  timestamp: number;
  /** Serialized size on disk, used for reclaim estimates. */
  bytes: number;
  /** Hash-chain pointer to the previous version of the same key, if any. */
  parentEventId?: string;
  /** Sealed on-chain events are never rewritten. */
  immutable?: boolean;
  /** Events under litigation hold are exempt from every policy. */
  legalHold?: boolean;
  /** Archived buckets are frozen once sealed. */
  sealed?: boolean;
  metadata?: Record<string, unknown>;
}

/** Storage segment (partition file / object) grouping events. */
export interface StoredSegment {
  id: string;
  contractId: string;
  eventIds: string[];
  bytes: number;
  createdAt: number;
}

/** An event that was evaluated but intentionally not removed. */
export interface CompactionSkip {
  id: string;
  reason: ProtectionReason | "out-of-scope";
}

/** Outcome of a single compaction pass. */
export interface CompactionResult {
  runId: string;
  startedAt: number;
  completedAt: number;
  dryRun: boolean;
  /** Events removed (or that would be removed on a dry run), grouped by reason. */
  compacted: Array<{ id: string; reason: CompactionReason; bytes: number }>;
  compactedIds: string[];
  /** Segments emptied by the pass and therefore eligible for deletion. */
  freedSegments: string[];
  reclaimedBytes: number;
  skipped: CompactionSkip[];
  errors: string[];
  durationMs: number;
}

/** Aggregation of a compaction history, used by the monitor. */
export interface CompactionMetrics {
  runs: number;
  failures: number;
  eventsCompacted: number;
  segmentsFreed: number;
  bytesReclaimed: number;
  lastRunAt: number | null;
  lastDurationMs: number;
  totalDurationMs: number;
  byReason: Record<CompactionReason, number>;
}

/** Thresholds that turn raw metrics into alert signals. */
export interface CompactionThresholds {
  maxDurationMs: number;
  maxFailures: number;
  minBytesReclaimed: number;
  maxRunIntervalMs: number;
}

export const DEFAULT_COMPACTION_THRESHOLDS: CompactionThresholds = {
  maxDurationMs: 5 * 60 * 1000,
  maxFailures: 3,
  minBytesReclaimed: 1,
  maxRunIntervalMs: 6 * 60 * 60 * 1000,
};

/** Signals raised when a compaction posture looks unhealthy. */
export type AlertSeverity = "info" | "warning" | "critical";

export interface CompactionAlert {
  code:
    | "repeated-failures"
    | "slow-compaction"
    | "low-reclaim"
    | "stalled-scheduler";
  severity: AlertSeverity;
  message: string;
}
