/**
 * Structured audit log formats (#428)
 *
 * The same entry is encoded for four consumers: humans and archives (json /
 * ndjson / csv), SIEM collectors (syslog 5424, CEF, ECS), and the tamper
 * evidence itself (the chain link travels with every record).
 */

import { canonicalize } from "./hashChain.ts";
import type { AuditEntry, AuditFormat, AuditSeverity } from "./types.ts";

const SEVERITY_TO_SYSLOG: Record<AuditSeverity, number> = {
  info: 6,
  low: 5,
  medium: 4,
  high: 3,
  critical: 2,
};

const SEVERITY_TO_CEF: Record<AuditSeverity, number> = {
  info: 1,
  low: 3,
  medium: 5,
  high: 8,
  critical: 10,
};

const SEVERITY_TO_ECS: Record<AuditSeverity, number> = {
  info: 1,
  low: 21,
  medium: 36,
  high: 51,
  critical: 68,
};

const CSV_COLUMNS = [
  "sequence",
  "timestamp",
  "timestampIso",
  "action",
  "outcome",
  "severity",
  "actorId",
  "actorType",
  "resourceId",
  "resourceType",
  "contractId",
  "eventId",
  "ledgerSequence",
  "correlationId",
  "outcomeReason",
  "tier",
  "sealed",
  "prevHash",
  "hash",
] as const;

/** Bare record, without chain metadata. */
function payload(entry: AuditEntry): Record<string, unknown> {
  return {
    sequence: entry.sequence,
    timestamp: entry.timestamp,
    timestampIso: entry.timestampIso,
    action: entry.action,
    outcome: entry.outcome,
    severity: entry.severity,
    actor: entry.actor,
    resource: entry.resource,
    contractId: entry.contractId,
    eventId: entry.eventId,
    ledgerSequence: entry.ledgerSequence,
    detail: entry.detail,
    correlationId: entry.correlationId,
    outcomeReason: entry.outcomeReason,
    tags: entry.tags,
  };
}

/** Full entry including the tamper-evidence links. */
export function toRecord(entry: AuditEntry): Record<string, unknown> {
  return {
    ...payload(entry),
    tier: entry.tier,
    sealed: entry.sealed,
    prevHash: entry.prevHash,
    hash: entry.hash,
  };
}

export function toJson(entries: AuditEntry[]): string {
  return JSON.stringify(entries.map(toRecord), null, 2);
}

export function toNdjson(entries: AuditEntry[]): string {
  return entries.map((entry) => JSON.stringify(toRecord(entry))).join("\n");
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "object" ? canonicalize(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(entries: AuditEntry[]): string {
  const rows = entries.map((entry) =>
    [
      entry.sequence,
      entry.timestamp,
      entry.timestampIso,
      entry.action,
      entry.outcome,
      entry.severity,
      entry.actor.id,
      entry.actor.type ?? "",
      entry.resource.id,
      entry.resource.type,
      entry.contractId ?? "",
      entry.eventId ?? "",
      entry.ledgerSequence ?? "",
      entry.correlationId ?? "",
      entry.outcomeReason ?? "",
      entry.tier,
      entry.sealed,
      entry.prevHash,
      entry.hash,
    ]
      .map(csvCell)
      .join(",")
  );
  return [CSV_COLUMNS.join(","), ...rows].join("\n");
}

/** RFC 5424 syslog line with the chain link in a structured data parameter. */
export function toSyslog5424(entry: AuditEntry, appName = "audit-ledger"): string {
  const hostname = typeof entry.actor.ip === "string" ? entry.actor.ip : "-";
  const structured =
    `[audit@32473 sequence="${entry.sequence}" action="${escapeParam(entry.action)}"` +
    ` outcome="${entry.outcome}" severity="${entry.severity}"` +
    ` actor="${escapeParam(entry.actor.id)}" resource="${escapeParam(entry.resource.id)}"` +
    ` prevHash="${entry.prevHash}" hash="${entry.hash}"]`;
  const message = escapeParam(
    entry.outcomeReason ?? `${entry.action} ${entry.outcome} on ${entry.resource.id}`
  );
  return `<${SEVERITY_TO_SYSLOG[entry.severity]}>1 ${toSyslogTimestamp(entry.timestamp)} ${hostname} ${appName} - - ${structured} ${message}`;
}

/** ArcSight CEF line, the most widely ingested SIEM dialect. */
export function toCef(entry: AuditEntry, vendor = "AuditLedger", product = "ContractEventAuditLog"): string {
  const extension = [
    `rt=${Math.round(entry.timestamp)}`,
    `suser=${entry.actor.id}`,
    `duser=${entry.resource.id}`,
    `dproc=${entry.resource.type}`,
    `act=${entry.action}`,
    `outcome=${entry.outcome}`,
    `msg=${(entry.outcomeReason ?? `${entry.action} ${entry.outcome}`).replace(/[|=]/g, " ")}`,
    `cs1Label=ContractId cs1=${entry.contractId ?? ""}`,
    `cs1Label=EventId cs1=${entry.eventId ?? ""}`,
    `cs2Label=ChainHash cs2=${entry.hash}`,
    `cs3Label=PrevHash cs3=${entry.prevHash}`,
  ].join(" ");
  return `CEF:0|${vendor}|${product}|1.0|${SEVERITY_TO_CEF[entry.severity]}|${entry.action}|${extension}`;
}

/** Elastic Common Schema event, for Elastic and other ECS-aware collectors. */
export function toEcs(entry: AuditEntry): Record<string, unknown> {
  return {
    "@timestamp": entry.timestampIso,
    ecs: { version: "8.11.0" },
    event: {
      kind: "event",
      category: ["configuration", "database"],
      type: [entry.outcome === "success" ? "change" : "access"],
      action: entry.action,
      outcome: entry.outcome,
      severity: SEVERITY_TO_ECS[entry.severity],
      sequence: entry.sequence,
      provider: "audit-ledger",
      reason: entry.outcomeReason,
    },
    user: { id: entry.actor.id, roles: entry.actor.roles, ip: entry.actor.ip },
    source: { ip: entry.actor.ip },
    related: { ip: entry.actor.ip ? [entry.actor.ip] : undefined },
    trace: { id: entry.correlationId },
    ledger: {
      contract_id: entry.contractId,
      event_id: entry.eventId,
      sequence: entry.ledgerSequence,
      prev_hash: entry.prevHash,
      hash: entry.hash,
      tier: entry.tier,
      sealed: entry.sealed,
    },
    message: entry.outcomeReason,
    labels: entry.tags,
    detail: entry.detail,
  };
}

function toSyslogTimestamp(epochMs: number): string {
  const iso = new Date(epochMs).toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 23)}Z`;
}

function escapeParam(value: string): string {
  return value.replace(/[\\"\]]/g, "\\$&");
}

/** Encodes a batch in the requested format. Line formats drop the tail newline. */
export function formatEntries(entries: AuditEntry[], format: AuditFormat): string {
  switch (format) {
    case "json":
      return toJson(entries);
    case "ndjson":
      return toNdjson(entries);
    case "csv":
      return toCsv(entries);
    case "syslog5424":
      return entries.map((entry) => toSyslog5424(entry)).join("\n");
    case "cef":
      return entries.map((entry) => toCef(entry)).join("\n");
    case "ecs":
      return JSON.stringify(entries.map(toEcs), null, 2);
  }
}

/** Per-entry encoding used when a batch is shipped line by line to a SIEM. */
export function formatEntry(entry: AuditEntry, format: AuditFormat): string {
  switch (format) {
    case "syslog5424":
      return toSyslog5424(entry);
    case "cef":
      return toCef(entry);
    case "ndjson":
      return toNdjson([entry]);
    case "csv":
      return toCsv([entry]);
    case "ecs":
      return JSON.stringify(toEcs(entry));
    case "json":
      return JSON.stringify(toRecord(entry), null, 2);
  }
}

/** Formats a single entry as a one-element batch. */
export function formatLine(entry: AuditEntry, format: AuditFormat): string {
  return formatEntry(entry, format);
}
