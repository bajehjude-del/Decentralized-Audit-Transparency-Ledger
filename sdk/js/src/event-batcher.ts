/**
 * Issue #392 — High-Level SDK Event Batching
 *
 * Implements the `EventBatcher` class for automatic batching of individual
 * event submissions with bounded queue size, latency timeout, concurrency,
 * and individual Promise resolution.
 */

import { Logger } from './logger';
import { SDKMetricsCollector, sdkMetrics } from './metrics';

export interface BatchEventInput {
  submitter: string;
  eventType: string;
  metadata: string;
  tag?: unknown;
}

export interface BatchSubmissionResult {
  eventId: string;
  durationMs: number;
  batchIndex: number;
}

export interface EventBatcherOptions {
  /** Maximum number of events in a batch before triggering an immediate flush (default: 50) */
  maxBatchSize?: number;
  /** Maximum milliseconds to wait before flushing pending events (default: 50ms) */
  maxWaitMs?: number;
  /** Maximum concurrent batch flushes allowed (default: 4) */
  concurrency?: number;
  /** Optional custom logger */
  logger?: Logger;
  /** Optional metrics collector instance */
  metrics?: SDKMetricsCollector;
  /** Optional batch submit function */
  submitFn?: (events: BatchEventInput[]) => Promise<string[]>;
}

interface QueuedItem {
  input: BatchEventInput;
  resolve: (result: BatchSubmissionResult) => void;
  reject: (err: unknown) => void;
  enqueuedAt: number;
}

export class EventBatcher {
  private maxBatchSize: number;
  private maxWaitMs: number;
  private concurrency: number;
  private logger?: Logger;
  private metrics: SDKMetricsCollector;
  private submitFn?: (events: BatchEventInput[]) => Promise<string[]>;

  private queue: QueuedItem[] = [];
  private timer: NodeJS.Timeout | null = null;
  private activeBatches = 0;
  private isStopped = false;

  constructor(options: EventBatcherOptions = {}) {
    this.maxBatchSize = Math.max(1, options.maxBatchSize ?? 50);
    this.maxWaitMs = Math.max(1, options.maxWaitMs ?? 50);
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.logger = options.logger;
    this.metrics = options.metrics ?? sdkMetrics;
    this.submitFn = options.submitFn;
  }

  /**
   * Set or update the batch submit function.
   */
  setSubmitFn(fn: (events: BatchEventInput[]) => Promise<string[]>): void {
    this.submitFn = fn;
  }

  /**
   * Queue a single event for automatic batching.
   * Returns a promise that resolves when the containing batch finishes.
   */
  queueEvent(event: BatchEventInput): Promise<BatchSubmissionResult> {
    if (this.isStopped) {
      return Promise.reject(new Error('EventBatcher is stopped; cannot enqueue new events.'));
    }

    return new Promise<BatchSubmissionResult>((resolve, reject) => {
      this.queue.push({
        input: event,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      });

      this.metrics.increment('batcher_events_queued');

      if (this.queue.length >= this.maxBatchSize) {
        this.triggerFlush();
      } else if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.triggerFlush();
        }, this.maxWaitMs);
      }
    });
  }

  /**
   * Current number of queued events waiting to be flushed.
   */
  get queueLength(): number {
    return this.queue.length;
  }

  /**
   * Number of batch submissions currently in flight.
   */
  get activeBatchesCount(): number {
    return this.activeBatches;
  }

  /**
   * Trigger an immediate flush of the current queue.
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.processQueue();
  }

  /**
   * Stop the batcher, flushing any pending items.
   */
  async stop(): Promise<void> {
    this.isStopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.processQueue();
  }

  private triggerFlush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.queue.length === 0) return;
    if (this.activeBatches >= this.concurrency) return;

    const chunk = this.queue.splice(0, this.maxBatchSize);
    if (chunk.length === 0) return;

    this.activeBatches++;
    const startTime = Date.now();

    this.metrics.record('batcher_batch_size', chunk.length);

    try {
      if (!this.submitFn) {
        throw new Error('No submit function configured on EventBatcher.');
      }

      const inputs = chunk.map((item) => item.input);
      const ids = await this.submitFn(inputs);

      const durationMs = Date.now() - startTime;
      this.metrics.record('batcher_flush_latency_ms', durationMs);
      this.metrics.increment('batcher_batches_succeeded');

      for (let i = 0; i < chunk.length; i++) {
        const item = chunk[i];
        const eventId = ids[i] ?? `event_batch_${Date.now()}_${i}`;
        item.resolve({
          eventId,
          durationMs: Date.now() - item.enqueuedAt,
          batchIndex: i,
        });
      }
    } catch (err) {
      this.metrics.increment('batcher_batches_failed');
      this.logger?.error('Batch submission failed', { error: err });
      for (const item of chunk) {
        item.reject(err);
      }
    } finally {
      this.activeBatches--;
      if (this.queue.length > 0) {
        void this.processQueue();
      }
    }
  }
}
