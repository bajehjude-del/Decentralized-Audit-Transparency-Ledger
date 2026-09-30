/**
 * Tamper-evident hash chain for the contract event audit log (#428)
 *
 * Each entry commits to the previous entry's hash, so a change to any entry
 * invalidates every hash after it. Deleting an entry leaves a `sequence-gap`,
 * and backdating one leaves a `timestamp-regression`; both are reported
 * alongside the `hash-mismatch` they eventually produce.
 */

import { createHash } from "node:crypto";

import type {
  AuditEntry,
  AuditRecord,
  IntegrityIssue,
  IntegrityReport,
} from "./types.ts";

/** Hash the first entry commits to. A real deployment should anchor this. */
export const GENESIS_HASH = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Deterministic JSON with sorted object keys. Hashing the canonical form means
 * two equal records always produce the same digest, whatever order the fields
 * were supplied in.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return "null";
  return JSON.stringify(value) ?? "null";
}

/** `sha256:<hex>` digest of an arbitrary payload. */
export function digest(payload: string): string {
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

/** Chain metadata that is deliberately outside the hashed body. */
const CHAIN_FIELDS = ["hash", "prevHash", "tier", "sealed"] as const;

/**
 * Strips chain metadata to recover the hashed body. Accepts either a bare
 * record or a full entry, so `entryHash` behaves identically for both and a
 * caller can recompute a hash from an entry straight out of the log.
 */
export function recordBody(value: AuditRecord | AuditEntry): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if ((CHAIN_FIELDS as readonly string[]).includes(key)) continue;
    body[key] = item;
  }
  return body;
}

/** Recomputes the chain hash an entry must carry. */
export function entryHash(value: AuditRecord | AuditEntry, prevHash: string): string {
  return digest(`${prevHash}|${canonicalize(recordBody(value))}`);
}

export class HashChain {
  private entries: AuditEntry[] = [];
  private readonly genesis: string;
  private readonly decorate: (entry: AuditEntry) => AuditEntry;

  constructor(options: { genesisHash?: string; decorate?: (entry: AuditEntry) => AuditEntry } = {}) {
    this.genesis = options.genesisHash ?? GENESIS_HASH;
    this.decorate = options.decorate ?? ((entry) => entry);
  }

  /** The hash the next entry will commit to. */
  head(): string {
    return this.entries.length === 0 ? this.genesis : this.entries[this.entries.length - 1].hash;
  }

  get length(): number {
    return this.entries.length;
  }

  /** Appends a record, stamping it with its sequence, links, and hash. */
  append(record: AuditRecord): AuditEntry {
    const prevHash = this.head();
    const entry = this.decorate({
      ...record,
      hash: entryHash(record, prevHash),
      prevHash,
    });
    this.entries.push(entry);
    return entry;
  }

  all(): AuditEntry[] {
    return this.entries;
  }

  /**
   * Recomputes every hash and link. The returned report is the evidence a
   * compliance reviewer or SIEM pipeline consumes.
   *
   * A pure hash chain cannot detect a rewrite that recomputed every hash, so
   * pass `expectedHead` (the value published to a transparency log, an external
   * anchor, or a notarised document) to close that gap.
   */
  verify(options: { now?: number; expectedHead?: string } = {}): IntegrityReport {
    const now = options.now ?? Date.now();
    const issues: IntegrityIssue[] = [];
    let expectedPrev = this.genesis;
    let previousSequence = 0;
    let previousTimestamp = Number.NEGATIVE_INFINITY;
    let recomputed = 0;

    for (const entry of this.entries) {
      const expectedHash = entryHash(entry, expectedPrev);

      if (entry.prevHash !== expectedPrev) {
        issues.push({
          sequence: entry.sequence,
          entryHash: entry.hash,
          kind: "broken-chain",
          message: `entry links to ${entry.prevHash} but the previous entry hashes to ${expectedPrev}`,
        });
      }
      if (entry.hash !== expectedHash) {
        issues.push({
          sequence: entry.sequence,
          entryHash: entry.hash,
          kind: entry.sequence === previousSequence + 1 ? "hash-mismatch" : "entry-tampered",
          message: `recomputed ${expectedHash} but entry stores ${entry.hash}`,
        });
      } else {
        recomputed += 1;
      }
      if (entry.sequence !== previousSequence + 1) {
        issues.push({
          sequence: entry.sequence,
          entryHash: entry.hash,
          kind: "sequence-gap",
          message: `expected sequence ${previousSequence + 1} but found ${entry.sequence}`,
        });
      }
      if (entry.timestamp < previousTimestamp) {
        issues.push({
          sequence: entry.sequence,
          entryHash: entry.hash,
          kind: "timestamp-regression",
          message: `timestamp ${new Date(entry.timestamp).toISOString()} precedes the previous entry`,
        });
      }

      previousSequence = entry.sequence;
      previousTimestamp = entry.timestamp;
      expectedPrev = entry.hash;
    }

    if (options.expectedHead !== undefined && options.expectedHead !== this.head()) {
      issues.push({
        sequence: this.entries.length,
        entryHash: this.head(),
        kind: "head-anchor-mismatch",
        message: `head hashes to ${this.head()} but the published anchor is ${options.expectedHead}`,
      });
    }

    return {
      valid: issues.length === 0,
      entries: this.entries.length,
      issues,
      headHash: this.head(),
      verifiedAt: now,
      recomputed,
    };
  }
}
