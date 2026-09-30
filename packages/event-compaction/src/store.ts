/**
 * In-memory contract event store used by the compactor (#427)
 *
 * The compactor only needs a very small surface: enumerate, probe and delete.
 * Keeping it behind an interface means a real store (Postgres, S3, IPFS) can be
 * dropped in without touching the compaction logic.
 */

import type { StoredEvent, StoredSegment } from "./types.ts";

export interface EventStore {
  listEvents(): StoredEvent[];
  getEvent(id: string): StoredEvent | undefined;
  removeEvents(ids: string[]): number;
  listSegments(): StoredSegment[];
  removeSegments(ids: string[]): number;
}

export class InMemoryEventStore implements EventStore {
  private events = new Map<string, StoredEvent>();
  private segments = new Map<string, StoredSegment>();
  private removalLog: string[] = [];

  constructor(events: StoredEvent[] = [], segments: StoredSegment[] = []) {
    for (const event of events) this.events.set(event.id, event);
    for (const segment of segments) this.segments.set(segment.id, segment);
  }

  listEvents(): StoredEvent[] {
    return [...this.events.values()];
  }

  getEvent(id: string): StoredEvent | undefined {
    return this.events.get(id);
  }

  removeEvents(ids: string[]): number {
    let removed = 0;
    for (const id of ids) {
      if (this.events.delete(id)) {
        this.removalLog.push(id);
        removed += 1;
      }
    }
    return removed;
  }

  listSegments(): StoredSegment[] {
    return [...this.segments.values()];
  }

  removeSegments(ids: string[]): number {
    let removed = 0;
    for (const id of ids) {
      if (this.segments.delete(id)) {
        this.removalLog.push(`segment:${id}`);
        removed += 1;
      }
    }
    return removed;
  }

  /** Number of events currently stored. */
  size(): number {
    return this.events.size;
  }

  /** Sum of stored event sizes, the store's current footprint. */
  totalBytes(): number {
    let total = 0;
    for (const event of this.events.values()) total += event.bytes;
    return total;
  }

  /** Ids of every event and segment this store instance has deleted. */
  removals(): string[] {
    return [...this.removalLog];
  }
}
