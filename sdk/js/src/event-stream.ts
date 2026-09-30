/**
 * Issue #392 — High-Level SDK Event Streaming with Backpressure
 *
 * Implements the `EventStream` class supporting backpressure handling,
 * configurable buffer highWaterMark, pause/resume flow control,
 * and async iteration for real-time and historical events.
 */

import { EventEmitter } from 'events';
import { Logger } from './logger';
import { SDKMetricsCollector, sdkMetrics } from './metrics';

export interface EventStreamOptions {
  /** Maximum number of unconsumed events buffered before exerting backpressure (default: 100) */
  highWaterMark?: number;
  /** Custom logger */
  logger?: Logger;
  /** Metrics collector */
  metrics?: SDKMetricsCollector;
}

export class EventStream<T> implements AsyncIterable<T> {
  private highWaterMark: number;
  private logger?: Logger;
  private metrics: SDKMetricsCollector;
  private buffer: T[] = [];
  private paused = false;
  private ended = false;
  private error: Error | null = null;
  private emitter = new EventEmitter();

  // Async iterator resolution queue
  private pullQueue: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (err: unknown) => void;
  }> = [];

  constructor(options: EventStreamOptions = {}) {
    this.highWaterMark = Math.max(1, options.highWaterMark ?? 100);
    this.logger = options.logger;
    this.metrics = options.metrics ?? sdkMetrics;
    this.emitter.setMaxListeners(0);
  }

  /**
   * Push an item into the stream buffer.
   * Returns `true` if buffer is below highWaterMark, or `false` if backpressure is applied.
   */
  push(item: T): boolean {
    if (this.ended) {
      throw new Error('Cannot push into an ended EventStream');
    }

    this.metrics.increment('stream_events_pushed');

    // If consumers are waiting for an item, deliver immediately
    if (this.pullQueue.length > 0 && !this.paused) {
      const pull = this.pullQueue.shift()!;
      pull.resolve({ value: item, done: false });
      return true;
    }

    this.buffer.push(item);
    this.metrics.setGauge('stream_buffer_size', this.buffer.length);

    const hasBackpressure = this.buffer.length >= this.highWaterMark;
    if (hasBackpressure) {
      this.metrics.increment('stream_backpressure_triggers');
      this.emitter.emit('backpressure', this.buffer.length);
    }

    return !hasBackpressure;
  }

  /**
   * Wait until the stream has drained below its highWaterMark threshold.
   */
  async waitForDrain(): Promise<void> {
    if (this.buffer.length < this.highWaterMark) {
      return;
    }
    return new Promise<void>((resolve) => {
      this.emitter.once('drain', () => resolve());
    });
  }

  /**
   * Signal that no more items will be pushed.
   */
  end(): void {
    this.ended = true;
    while (this.pullQueue.length > 0) {
      const pull = this.pullQueue.shift()!;
      if (this.buffer.length > 0) {
        pull.resolve({ value: this.buffer.shift()!, done: false });
      } else {
        pull.resolve({ value: undefined, done: true });
      }
    }
    this.emitter.emit('end');
  }

  /**
   * Signal a stream error.
   */
  emitError(err: Error): void {
    this.error = err;
    while (this.pullQueue.length > 0) {
      const pull = this.pullQueue.shift()!;
      pull.reject(err);
    }
    this.emitter.emit('error', err);
  }

  /**
   * Pause stream consumption.
   */
  pause(): void {
    this.paused = true;
    this.emitter.emit('pause');
  }

  /**
   * Resume stream consumption.
   */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.emitter.emit('resume');

    // Drain queued consumers from buffer
    while (this.pullQueue.length > 0 && this.buffer.length > 0) {
      const pull = this.pullQueue.shift()!;
      const val = this.buffer.shift()!;
      pull.resolve({ value: val, done: false });
    }

    if (this.buffer.length < this.highWaterMark) {
      this.emitter.emit('drain');
    }
  }

  /**
   * Check if stream is currently paused.
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Check if stream is experiencing backpressure.
   */
  isBackpressured(): boolean {
    return this.buffer.length >= this.highWaterMark;
  }

  /**
   * Current number of buffered items.
   */
  get bufferedCount(): number {
    return this.buffer.length;
  }

  /**
   * Register a listener for stream events ('drain', 'backpressure', 'pause', 'resume', 'end', 'error').
   */
  on(event: string, listener: (...args: unknown[]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  /**
   * Async iterator protocol implementation.
   */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.error) {
          return Promise.reject(this.error);
        }

        if (!this.paused && this.buffer.length > 0) {
          const val = this.buffer.shift()!;
          this.metrics.setGauge('stream_buffer_size', this.buffer.length);

          if (this.buffer.length < this.highWaterMark) {
            this.emitter.emit('drain');
          }

          return Promise.resolve({ value: val, done: false });
        }

        if (this.ended && this.buffer.length === 0) {
          return Promise.resolve({ value: undefined, done: true });
        }

        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.pullQueue.push({ resolve, reject });
        });
      },
    };
  }
}
