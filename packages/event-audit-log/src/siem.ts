/**
 * SIEM delivery for the contract event audit log (#428)
 *
 * Records are buffered, encoded in a SIEM dialect, and shipped in batches with
 * bounded retries and exponential backoff. Delivery never throws: failures are
 * counted and reported so the caller can decide whether to alert or replay.
 */

import { formatEntry } from "./formats.ts";
import type {
  AuditEntry,
  AuditFormat,
  FlushResult,
  SiemDeliveryResult,
  SiemTransport,
} from "./types.ts";

export interface SiemSinkOptions {
  transport: SiemTransport;
  /** Dialect used to encode each entry. */
  format?: AuditFormat;
  /** Entries per batch. */
  batchSize?: number;
  /** Total delivery attempts per batch, including the first. */
  maxAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Injected so tests and sidecars can control time. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface QueuedBatch {
  entries: AuditEntry[];
  lines: string[];
  attempts: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class SiemSink {
  private readonly transport: SiemTransport;
  private readonly format: AuditFormat;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private queue: AuditEntry[] = [];
  private readonly batches: QueuedBatch[] = [];
  private dropped = 0;

  constructor(options: SiemSinkOptions) {
    this.transport = options.transport;
    this.format = options.format ?? "cef";
    this.batchSize = options.batchSize ?? 50;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.initialBackoffMs = options.initialBackoffMs ?? 250;
    this.maxBackoffMs = options.maxBackoffMs ?? 5_000;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Buffers an entry, flushing automatically once a batch is full. */
  async enqueue(entry: AuditEntry): Promise<FlushResult | null> {
    this.queue.push(entry);
    if (this.queue.length < this.batchSize) return null;
    return this.flush();
  }

  /** Buffers many entries at once, flushing each time a batch fills up. */
  async enqueueAll(entries: AuditEntry[]): Promise<FlushResult | null> {
    let merged: FlushResult | null = null;
    for (const entry of entries) {
      const flushed = await this.enqueue(entry);
      if (flushed) merged = merged === null ? flushed : mergeFlush(merged, flushed);
    }
    return merged;
  }

  /** Number of entries waiting to be shipped. */
  pending(): number {
    return this.queue.length;
  }

  /** Entries lost because every delivery attempt failed. */
  droppedCount(): number {
    return this.dropped;
  }

  /** Flushes everything buffered. A no-op flush still reports a result. */
  async flush(): Promise<FlushResult> {
    const flushedAt = this.now();
    if (this.queue.length === 0) {
      return { accepted: 0, attempts: 0, errors: [], batches: 0, flushedAt };
    }

    const pending = this.queue;
    this.queue = [];
    let accepted = 0;
    let attempts = 0;
    const errors: string[] = [];

    for (let offset = 0; offset < pending.length; offset += this.batchSize) {
      const entries = pending.slice(offset, offset + this.batchSize);
      const lines = entries.map((entry) => formatEntry(entry, this.format));
      const result = await this.deliver(entries, lines);
      attempts += result.attempts;
      accepted += result.accepted;
      errors.push(...result.errors);
      if (result.accepted < entries.length) this.dropped += entries.length - result.accepted;
    }

    return { accepted, attempts, errors, batches: this.batches.length, flushedAt };
  }

  /** Retry history, for replay tooling and incident review. */
  history(): QueuedBatch[] {
    return this.batches;
  }

  private async deliver(entries: AuditEntry[], lines: string[]): Promise<SiemDeliveryResult> {
    let attempts = 0;
    const errors: string[] = [];
    let backoff = this.initialBackoffMs;

    while (attempts < this.maxAttempts) {
      attempts += 1;
      try {
        const result = await this.transport.send(lines);
        this.batches.push({ entries, lines, attempts });
        if (result.errors.length > 0) errors.push(...result.errors);
        return {
          accepted: Math.min(result.accepted, entries.length),
          attempts,
          errors,
        };
      } catch (error) {
        errors.push(describe(error));
        if (attempts >= this.maxAttempts) break;
        await this.sleep(Math.min(backoff, this.maxBackoffMs));
        backoff *= 2;
      }
    }

    this.batches.push({ entries, lines, attempts });
    return { accepted: 0, attempts, errors };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeFlush(first: FlushResult, second: FlushResult): FlushResult {
  return {
    accepted: first.accepted + second.accepted,
    attempts: first.attempts + second.attempts,
    errors: [...first.errors, ...second.errors],
    batches: first.batches + second.batches,
    flushedAt: second.flushedAt,
  };
}

/** A transport that records every batch in memory. Useful for tests and dry runs. */
export function memoryTransport(): SiemTransport & {
  batches: string[][];
  setFailure: (failure: string | null) => void;
} {
  const batches: string[][] = [];
  let failure: string | null = null;
  return {
    name: "memory",
    batches,
    setFailure(next: string | null) {
      failure = next;
    },
    send(batch: string[]) {
      if (failure) throw new Error(failure);
      batches.push([...batch]);
      return { accepted: batch.length, attempts: 1, errors: [] };
    },
  };
}

/** A transport that POSTs newline-delimited payloads. */
export function httpTransport(options: {
  url: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}): SiemTransport {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    name: "http",
    async send(batch: string[]) {
      const response = await doFetch(options.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...options.headers },
        body: JSON.stringify({ lines: batch }),
      });
      if (!response.ok) throw new Error(`SIEM endpoint returned HTTP ${response.status}`);
      return { accepted: batch.length, attempts: 1, errors: [] };
    },
  };
}

/** A transport that appends to an in-memory sink, standing in for a file. */
export function stdoutTransport(sink: string[] = []): SiemTransport & { lines: string[] } {
  return {
    name: "stdout",
    lines: sink,
    send(batch: string[]) {
      sink.push(...batch);
      return { accepted: batch.length, attempts: 1, errors: [] };
    },
  };
}
