/**
 * Compliance reporting for the contract event audit log (#428)
 *
 * Maps observed audit evidence onto the controls auditors actually ask about,
 * and renders the result as a report a human or a filing system can consume.
 */

import type {
  AuditEntry,
  ComplianceFramework,
  ComplianceReport,
  ControlMapping,
  IntegrityReport,
} from "./types.ts";

/** Control catalogue per framework, keyed by control id. */
export const CONTROL_CATALOGUE: Record<ComplianceFramework, ControlMapping[]> = {
  SOC2: [
    { framework: "SOC2", control: "CC6.1", title: "Logical access controls", satisfied: false, evidence: "" },
    { framework: "SOC2", control: "CC6.2", title: "Prior to issuing credentials, register and authorise users", satisfied: false, evidence: "" },
    { framework: "SOC2", control: "CC6.3", title: "Access to data and software is granted and modified by authorisation", satisfied: false, evidence: "" },
    { framework: "SOC2", control: "CC7.2", title: "Anomalies and security events are monitored", satisfied: false, evidence: "" },
    { framework: "SOC2", control: "CC7.3", title: "Security events are evaluated for impact", satisfied: false, evidence: "" },
  ],
  ISO27001: [
    { framework: "ISO27001", control: "A.8.15", title: "Logging", satisfied: false, evidence: "" },
    { framework: "ISO27001", control: "A.8.16", title: "Monitoring activities", satisfied: false, evidence: "" },
    { framework: "ISO27001", control: "A.8.13", title: "Information backup", satisfied: false, evidence: "" },
    { framework: "ISO27001", control: "A.5.28", title: "Collection of evidence", satisfied: false, evidence: "" },
  ],
  GDPR: [
    { framework: "GDPR", control: "Art.5(2)", title: "Accountability", satisfied: false, evidence: "" },
    { framework: "GDPR", control: "Art.30", title: "Records of processing activities", satisfied: false, evidence: "" },
    { framework: "GDPR", control: "Art.32", title: "Security of processing", satisfied: false, evidence: "" },
  ],
  SOX: [
    { framework: "SOX", control: "302.A", title: "Disclosure controls and procedures", satisfied: false, evidence: "" },
    { framework: "SOX", control: "404.A", title: "Internal control over financial reporting", satisfied: false, evidence: "" },
    { framework: "SOX", control: "802", title: "Retention of records", satisfied: false, evidence: "" },
  ],
  MiCA: [
    { framework: "MiCA", control: "Art.72", title: "Record keeping by CASPs", satisfied: false, evidence: "" },
    { framework: "MiCA", control: "Art.66", title: "Reporting to competent authorities", satisfied: false, evidence: "" },
  ],
};

/** Controls for a framework, optionally narrowed to specific ids. */
export function controlsFor(
  framework: ComplianceFramework,
  only?: string[]
): ControlMapping[] {
  const all = CONTROL_CATALOGUE[framework] ?? [];
  if (!only || only.length === 0) return all.map((control) => ({ ...control }));
  const wanted = new Set(only);
  return all.filter((control) => wanted.has(control.control)).map((control) => ({ ...control }));
}

export interface EvidenceSummary {
  entries: number;
  firstEntryAt: number | null;
  lastEntryAt: number | null;
  coverageMs: number;
  actionsCovered: string[];
  distinctActors: number;
  deniedOperations: number;
  integrity: IntegrityReport;
}

/** Factual summary of a set of entries, independent of any framework. */
export function summarize(entries: AuditEntry[], integrity: IntegrityReport): EvidenceSummary {
  const actions = new Set<string>();
  const actors = new Set<string>();
  let firstEntryAt: number | null = null;
  let lastEntryAt: number | null = null;
  let deniedOperations = 0;

  for (const entry of entries) {
    actions.add(entry.action);
    actors.add(entry.actor.id);
    if (entry.outcome === "denied") deniedOperations += 1;
    if (firstEntryAt === null || entry.timestamp < firstEntryAt) firstEntryAt = entry.timestamp;
    if (lastEntryAt === null || entry.timestamp > lastEntryAt) lastEntryAt = entry.timestamp;
  }

  return {
    entries: entries.length,
    firstEntryAt,
    lastEntryAt,
    coverageMs: firstEntryAt !== null && lastEntryAt !== null ? lastEntryAt - firstEntryAt : 0,
    actionsCovered: [...actions].sort(),
    distinctActors: actors.size,
    deniedOperations,
    integrity,
  };
}

export interface FrameworkVerdict {
  framework: ComplianceFramework;
  total: number;
  satisfied: number;
  unsatisfied: number;
  passed: boolean;
}

/** Roll-up of a report's controls into a pass/fail verdict. */
export function verdict(report: ComplianceReport): FrameworkVerdict {
  const satisfied = report.controls.filter((control) => control.satisfied).length;
  return {
    framework: report.framework,
    total: report.controls.length,
    satisfied,
    unsatisfied: report.controls.length - satisfied,
    passed: report.controls.length > 0 && satisfied === report.controls.length,
  };
}

export function reportToJson(report: ComplianceReport): string {
  return JSON.stringify(report, null, 2);
}

const REPORT_CSV_COLUMNS = [
  "framework",
  "control",
  "title",
  "satisfied",
  "evidence",
] as const;

export function reportToCsv(report: ComplianceReport): string {
  const escape = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const rows = report.controls.map((control) =>
    [control.framework, control.control, control.title, String(control.satisfied), control.evidence]
      .map((cell) => escape(cell))
      .join(",")
  );
  return [REPORT_CSV_COLUMNS.join(","), ...rows].join("\n");
}

/** Compact one-line summary suitable for a CI job or a compliance ticket. */
export function toSummaryLine(report: ComplianceReport): string {
  const result = verdict(report);
  return `${report.framework}: ${result.satisfied}/${result.total} controls satisfied, ` +
    `${report.totalRecords} audit records, integrity ${report.integrity.valid ? "verified" : "FAILED"}`;
}
