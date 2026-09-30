import { createHash } from "crypto";

/**
 * Bridge Event Filtering (#255)
 *
 * Provides selective bridging by filtering events on type, submitter,
 * and time range before they are handed to proof generation / submission.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AuditEvent {
  index: number;
  timestamp: number;
  event_type: string;
  submitter: string;
  metadata: string;
  event_hash: string;
  ledger_seq: number;
  tx_hash: string;
  category?: string;
  [key: string]: unknown;
}

export interface EventTypeFilter {
  include?: string[];
  exclude?: string[];
}

export interface SubmitterFilter {
  include?: string[];
  exclude?: string[];
}

export interface TimeRangeFilter {
  fromTimestamp?: number;
  toTimestamp?: number;
}

export interface CategoryFilter {
  include?: string[];
  exclude?: string[];
}

export interface MetadataSearchFilter {
  query?: string;
  fields?: string[];
  caseSensitive?: boolean;
}

export interface PaginationOptions {
  offset?: number;
  limit?: number;
  cursor?: string;
}

export interface SortOptions {
  field?: keyof AuditEvent | string;
  direction?: "asc" | "desc";
}

export interface FilterConfig {
  eventType?: EventTypeFilter;
  submitter?: SubmitterFilter;
  timeRange?: TimeRangeFilter;
  category?: CategoryFilter;
  metadataSearch?: MetadataSearchFilter;
  sort?: SortOptions;
  pagination?: PaginationOptions;
}

export interface FilterResult {
  passed: AuditEvent[];
  rejected: Array<{ event: AuditEvent; reason: string }>;
}

export interface PaginatedFilterResult extends FilterResult {
  total: number;
  offset: number;
  limit: number;
  nextCursor: string | null;
}

export interface EventStats {
  total: number;
  passed: number;
  rejected: number;
  byType: Record<string, number>;
  bySubmitter: Record<string, number>;
  byCategory: Record<string, number>;
  ratePerSecond: number;
  earliestTimestamp: number | null;
  latestTimestamp: number | null;
}

export interface HashChainNode {
  index: number;
  event_hash: string;
  previous_hash: string | null;
  valid: boolean;
}

export interface HashChainResult {
  chain: HashChainNode[];
  valid: boolean;
  brokenAt: number | null;
}

// ── Filter implementations ────────────────────────────────────────────────────

function matchesEventType(event: AuditEvent, filter?: EventTypeFilter): string | null {
  if (!filter) return null;

  if (filter.include && filter.include.length > 0 && !filter.include.includes(event.event_type)) {
    return `event_type '${event.event_type}' not in include list`;
  }

  if (filter.exclude && filter.exclude.includes(event.event_type)) {
    return `event_type '${event.event_type}' is excluded`;
  }

  return null;
}

function matchesSubmitter(event: AuditEvent, filter?: SubmitterFilter): string | null {
  if (!filter) return null;

  if (filter.include && filter.include.length > 0 && !filter.include.includes(event.submitter)) {
    return `submitter '${event.submitter}' not in include list`;
  }

  if (filter.exclude && filter.exclude.includes(event.submitter)) {
    return `submitter '${event.submitter}' is excluded`;
  }

  return null;
}

function matchesTimeRange(event: AuditEvent, filter?: TimeRangeFilter): string | null {
  if (!filter) return null;

  if (filter.fromTimestamp !== undefined && event.timestamp < filter.fromTimestamp) {
    return `timestamp ${event.timestamp} before fromTimestamp ${filter.fromTimestamp}`;
  }

  if (filter.toTimestamp !== undefined && event.timestamp > filter.toTimestamp) {
    return `timestamp ${event.timestamp} after toTimestamp ${filter.toTimestamp}`;
  }

  return null;
}

function matchesCategory(event: AuditEvent, filter?: CategoryFilter): string | null {
  if (!filter) return null;

  const category = event.category ?? "";

  if (filter.include && filter.include.length > 0 && !filter.include.includes(category)) {
    return `category '${category}' not in include list`;
  }

  if (filter.exclude && filter.exclude.includes(category)) {
    return `category '${category}' is excluded`;
  }

  return null;
}

function matchesMetadataSearch(event: AuditEvent, filter?: MetadataSearchFilter): string | null {
  if (!filter || !filter.query) return null;

  const query = filter.caseSensitive ? filter.query : filter.query.toLowerCase();
  const fields = filter.fields && filter.fields.length > 0 ? filter.fields : ["metadata"];

  for (const field of fields) {
    const raw = (event as Record<string, unknown>)[field];
    if (raw === undefined || raw === null) continue;

    const value = typeof raw === "string" ? raw : JSON.stringify(raw);
    const haystack = filter.caseSensitive ? value : value.toLowerCase();

    if (haystack.includes(query)) return null;
  }

  return `metadata search '${filter.query}' did not match`;
}

function compareEvents(a: AuditEvent, b: AuditEvent, sort?: SortOptions): number {
  if (!sort || !sort.field) return 0;

  const field = sort.field as string;
  const av = (a as Record<string, unknown>)[field];
  const bv = (b as Record<string, unknown>)[field];

  if (av === bv) return 0;
  if (av === undefined || av === null) return 1;
  if (bv === undefined || bv === null) return -1;

  let cmp: number;
  if (typeof av === "number" && typeof bv === "number") {
    cmp = av - bv;
  } else {
    cmp = String(av).localeCompare(String(bv));
  }

  return sort.direction === "desc" ? -cmp : cmp;
}

// ── Filter class ──────────────────────────────────────────────────────────────

export class EventFilter {
  private config: FilterConfig;

  constructor(config: FilterConfig = {}) {
    this.config = { ...config };
  }

  configure(config: Partial<FilterConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): FilterConfig {
    return { ...this.config };
  }

  reset(): void {
    this.config = {};
  }

  /** Returns the rejection reason for an event, or null if it passes all filters. */
  test(event: AuditEvent): string | null {
    return (
      matchesEventType(event, this.config.eventType) ??
      matchesSubmitter(event, this.config.submitter) ??
      matchesTimeRange(event, this.config.timeRange) ??
      matchesCategory(event, this.config.category) ??
      matchesMetadataSearch(event, this.config.metadataSearch) ??
      null
    );
  }

  matches(event: AuditEvent): boolean {
    return this.test(event) === null;
  }

  apply(events: AuditEvent[]): FilterResult {
    return this.applyWithPagination(events);
  }

  applyWithPagination(events: AuditEvent[]): PaginatedFilterResult {
    const passed: AuditEvent[] = [];
    const rejected: Array<{ event: AuditEvent; reason: string }> = [];

    for (const event of events) {
      const reason = this.test(event);
      if (reason === null) {
        passed.push(event);
      } else {
        rejected.push({ event, reason });
      }
    }

    const sorted = [...passed].sort((a, b) => compareEvents(a, b, this.config.sort));

    const total = sorted.length;
    const offset = this.config.pagination?.offset ?? 0;
    const limit = this.config.pagination?.limit ?? total;
    const page = sorted.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    const nextCursor = nextOffset < total ? String(nextOffset) : null;

    return {
      passed: page,
      rejected,
      total,
      offset,
      limit,
      nextCursor,
    };
  }

  /** Compute aggregate statistics over a set of events. */
  static stats(events: AuditEvent[]): EventStats {
    const byType: Record<string, number> = {};
    const bySubmitter: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    let earliest: number | null = null;
    let latest: number | null = null;

    for (const event of events) {
      byType[event.event_type] = (byType[event.event_type] ?? 0) + 1;
      bySubmitter[event.submitter] = (bySubmitter[event.submitter] ?? 0) + 1;
      const category = event.category ?? "uncategorized";
      byCategory[category] = (byCategory[category] ?? 0) + 1;

      if (earliest === null || event.timestamp < earliest) earliest = event.timestamp;
      if (latest === null || event.timestamp > latest) latest = event.timestamp;
    }

    const span = earliest !== null && latest !== null ? Math.max(latest - earliest, 1) : 1;
    const ratePerSecond = events.length / span;

    return {
      total: events.length,
      passed: events.length,
      rejected: 0,
      byType,
      bySubmitter,
      byCategory,
      ratePerSecond,
      earliestTimestamp: earliest,
      latestTimestamp: latest,
    };
  }

  /** Build a hash chain visualization from a list of events. */
  static hashChain(events: AuditEvent[]): HashChainResult {
    const chain: HashChainNode[] = [];
    let previousHash: string | null = null;
    let valid = true;
    let brokenAt: number | null = null;

    for (const event of events) {
      const expected = previousHash === null
        ? null
        : createHash("sha256").update(previousHash + event.event_hash).digest("hex");

      const nodeValid = expected === null || expected === event.event_hash || previousHash === null;
      if (!nodeValid && valid) {
        valid = false;
        brokenAt = event.index;
      }

      chain.push({
        index: event.index,
        event_hash: event.event_hash,
        previous_hash: previousHash,
        valid: nodeValid,
      });

      previousHash = event.event_hash;
    }

    return { chain, valid, brokenAt };
  }

  /** Export filtered events to JSON, CSV, or Parquet-compatible JSON. */
  static export(events: AuditEvent[], format: "json" | "csv" | "parquet"): string {
    if (format === "json") {
      return JSON.stringify(events, null, 2);
    }

    if (format === "csv") {
      if (events.length === 0) return "";
      const headers = Array.from(
        events.reduce<Set<string>>((set, event) => {
          Object.keys(event).forEach((key) => set.add(key));
          return set;
        }, new Set<string>()),
      );
      const rows = events.map((event) =>
        headers
          .map((header) => {
            const value = (event as Record<string, unknown>)[header];
            const str = value === undefined || value === null ? "" : String(value);
            return `"${str.replace(/"/g, '""')}"`;
          })
          .join(","),
      );
      return [headers.join(","), ...rows].join("\n");
    }

    // Parquet-compatible columnar JSON representation.
    const columns: Record<string, unknown[]> = {};
    for (const event of events) {
      for (const [key, value] of Object.entries(event)) {
        if (!columns[key]) columns[key] = [];
        columns[key].push(value);
      }
    }
    return JSON.stringify({ columns, rowCount: events.length });
  }
}

// ── Utility constructors ──────────────────────────────────────────────────────

export function createEventTypeFilter(include?: string[], exclude?: string[]): EventFilter {
  return new EventFilter({ eventType: { include, exclude } });
}

export function createSubmitterFilter(include?: string[], exclude?: string[]): EventFilter {
  return new EventFilter({ submitter: { include, exclude } });
}

export function createTimeRangeFilter(fromTimestamp?: number, toTimestamp?: number): EventFilter {
  return new EventFilter({ timeRange: { fromTimestamp, toTimestamp } });
}

export function createCategoryFilter(include?: string[], exclude?: string[]): EventFilter {
  return new EventFilter({ category: { include, exclude } });
}

export function createMetadataSearchFilter(
  query: string,
  fields?: string[],
  caseSensitive?: boolean,
): EventFilter {
  return new EventFilter({ metadataSearch: { query, fields, caseSensitive } });
}
