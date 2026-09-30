/**
 * Contract event audit logging types (#428)
 *
 * An audit record describes one contract operation. Records are wrapped in a
 * hash-chained entry so any later edit, reorder, or deletion is detectable.
 */

/** Operations that are expected to appear in the audit log. */
export const AUDIT_ACTIONS = {
  CONTRACT_DEPLOY: "contract.deploy",
  CONTRACT_UPGRADE: "contract.upgrade",
  CONTRACT_PAUSE: "contract.pause",
  CONTRACT_RESUME: "contract.resume",
  CONTRACT_DESTROY: "contract.destroy",
  EVENT_EMIT: "event.emit",
  EVENT_READ: "event.read",
  EVENT_EXPORT: "event.export",
  EVENT_DELETE: "event.delete",
  GOVERNANCE_PROPOSE: "governance.propose",
  GOVERNANCE_VOTE: "governance.vote",
  GOVERNANCE_EXECUTE: "governance.execute",
  KEY_ROTATE: "key.rotate",
  ACCESS_GRANT: "access.grant",
  ACCESS_REVOKE: "access.revoke",
} as const;

export type KnownAuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** Known actions are suggested, but a deployment may define its own. */
export type AuditAction = KnownAuditAction | (string & {});

export type AuditOutcome = "success" | "failure" | "denied";

export type AuditSeverity = "info" | "low" | "medium" | "high" | "critical";

export type ActorType = "user" | "service" | "contract" | "anonymous";

export interface AuditActor {
  id: string;
  type?: ActorType;
  ip?: string;
  roles?: string[];
}

export interface AuditResource {
  id: string;
  type: string;
  contractId?: string;
}

/** What a caller supplies; ids, hashes, and sequence numbers are assigned. */
export interface AuditInput {
  action: AuditAction;
  outcome: AuditOutcome;
  actor: AuditActor;
  resource: AuditResource;
  contractId?: string;
  eventId?: string;
  ledgerSequence?: number;
  detail?: Record<string, unknown>;
  severity?: AuditSeverity;
  correlationId?: string;
  outcomeReason?: string;
  tags?: string[];
  timestamp?: number;
}

/** The stable, hashable body of a record. */
export interface AuditRecord {
  sequence: number;
  timestamp: number;
  timestampIso: string;
  action: AuditAction;
  outcome: AuditOutcome;
  severity: AuditSeverity;
  actor: AuditActor;
  resource: AuditResource;
  contractId?: string;
  eventId?: string;
  ledgerSequence?: number;
  detail?: Record<string, unknown>;
  correlationId?: string;
  outcomeReason?: string;
  tags?: string[];
}

/** A record plus its position in the tamper-evident chain. */
export interface AuditEntry extends AuditRecord {
  /** `sha256:<hex>` over the canonical record and `prevHash`. */
  hash: string;
  prevHash: string;
  /** Retention tier the entry currently sits in. */
  tier: RetentionTier;
  /** Sealed entries are frozen: they can be read and exported, never edited. */
  sealed: boolean;
}

/** Storage tier of an entry, from cheapest to most durable. */
export type RetentionTier = "hot" | "warm" | "cold" | "archive";

export interface RetentionRule {
  tier: RetentionTier;
  /** Age at or above which an entry belongs in this tier. */
  afterMs: number;
  /** Sealed tiers are write-once, read-many. */
  immutable: boolean;
  description: string;
}

export interface RetentionPolicy {
  rules: RetentionRule[];
  /** Minimum age before any entry may be destroyed, regardless of tier. */
  minRetentionMs: number;
  /** When true, sealing a tier is refused, which is the WORM guarantee. */
  writeOnce: boolean;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  rules: [
    { tier: "hot", afterMs: 0, immutable: false, description: "Online query, full fidelity" },
    { tier: "warm", afterMs: 7 * 24 * 60 * 60 * 1000, immutable: false, description: "Cheap object storage, indexed" },
    { tier: "cold", afterMs: 90 * 24 * 60 * 60 * 1000, immutable: true, description: "Archival storage, sealed" },
    { tier: "archive", afterMs: 365 * 24 * 60 * 60 * 1000, immutable: true, description: "Write-once long-term archive" },
  ],
  minRetentionMs: 7 * 365 * 24 * 60 * 60 * 1000,
  writeOnce: true,
};

export type IntegrityIssueKind =
  | "hash-mismatch"
  | "broken-chain"
  | "sequence-gap"
  | "timestamp-regression"
  | "entry-tampered"
  | "head-anchor-mismatch";

export interface IntegrityIssue {
  sequence: number;
  entryHash: string;
  kind: IntegrityIssueKind;
  message: string;
}

export interface IntegrityReport {
  valid: boolean;
  entries: number;
  issues: IntegrityIssue[];
  headHash: string;
  verifiedAt: number;
  /** Entries whose recorded hash was recomputed successfully. */
  recomputed: number;
}

export interface AuditQuery {
  action?: AuditAction;
  actorId?: string;
  outcome?: AuditOutcome;
  severity?: AuditSeverity;
  contractId?: string;
  eventId?: string;
  correlationId?: string;
  from?: number;
  to?: number;
  limit?: number;
}

/** Structured output encodings, including the SIEM dialects. */
export type AuditFormat =
  | "json"
  | "ndjson"
  | "csv"
  | "syslog5424"
  | "cef"
  | "ecs";

export interface SiemDeliveryResult {
  accepted: number;
  attempts: number;
  errors: string[];
}

export interface SiemTransport {
  readonly name: string;
  send(batch: string[]): Promise<SiemDeliveryResult> | SiemDeliveryResult;
}

export interface FlushResult extends SiemDeliveryResult {
  batches: number;
  flushedAt: number;
}

export type ComplianceFramework = "SOC2" | "ISO27001" | "GDPR" | "SOX" | "MiCA";

export interface ControlMapping {
  framework: ComplianceFramework;
  control: string;
  title: string;
  satisfied: boolean;
  evidence: string;
}

export interface ComplianceReport {
  framework: ComplianceFramework;
  generatedAt: number;
  period: { from: number; to: number };
  totalRecords: number;
  byAction: Record<string, number>;
  byOutcome: Record<AuditOutcome, number>;
  bySeverity: Record<AuditSeverity, number>;
  byTier: Record<RetentionTier, number>;
  topActors: Array<{ actorId: string; records: number; failures: number; denials: number }>;
  integrity: IntegrityReport;
  controls: ControlMapping[];
  /** Earliest timestamp at which any entry may legally be destroyed. */
  retentionDeadline: number | null;
}
