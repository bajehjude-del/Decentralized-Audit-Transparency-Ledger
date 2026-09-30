/**
 * Issue #392 — Reactive Programming Patterns & Operators
 *
 * Implements reactive operators (`filter`, `map`, `debounce`, `throttle`, `buffer`)
 * and a fluent `ReactiveEventStream<T>` pipeline wrapper.
 */

import { EventStream } from './event-stream';

export type Operator<T, R> = (source: AsyncIterable<T>) => AsyncIterable<R>;

/**
 * Filter operator: Emits only values matching the predicate.
 */
export function filter<T>(predicate: (item: T) => boolean | Promise<boolean>): Operator<T, T> {
  return async function* (source: AsyncIterable<T>): AsyncIterable<T> {
    for await (const item of source) {
      if (await predicate(item)) {
        yield item;
      }
    }
  };
}

/**
 * Map operator: Transforms each emitted value.
 */
export function map<T, R>(project: (item: T) => R | Promise<R>): Operator<T, R> {
  return async function* (source: AsyncIterable<T>): AsyncIterable<R> {
    for await (const item of source) {
      yield await project(item);
    }
  };
}

/**
 * Debounce operator: Emits a value only after a specified quiet period (ms) has elapsed.
 */
export function debounce<T>(waitMs: number): Operator<T, T> {
  return async function* (source: AsyncIterable<T>): AsyncIterable<T> {
    let latest: { value: T } | null = null;
    let timer: NodeJS.Timeout | null = null;
    let resolveNext: ((item: T) => void) | null = null;
    let isDone = false;

    // Background reader loop
    const readerPromise = (async () => {
      try {
        for await (const item of source) {
          latest = { value: item };
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            if (latest && resolveNext) {
              const cb = resolveNext;
              resolveNext = null;
              const val = latest.value;
              latest = null;
              cb(val);
            }
          }, waitMs);
        }
      } finally {
        isDone = true;
      }
    })();

    while (!isDone || latest !== null) {
      if (latest && !timer) {
        yield latest.value;
        latest = null;
      } else {
        const item = await new Promise<T | null>((resolve) => {
          resolveNext = resolve;
          if (isDone && !latest) resolve(null);
        });
        if (item !== null) {
          yield item;
        }
      }
    }

    await readerPromise;
  };
}

/**
 * Throttle operator: Emits the first value immediately, then ignores subsequent values
 * for the duration of the throttle window (ms).
 */
export function throttle<T>(intervalMs: number): Operator<T, T> {
  return async function* (source: AsyncIterable<T>): AsyncIterable<T> {
    let lastEmitTime = 0;
    for await (const item of source) {
      const now = Date.now();
      if (now - lastEmitTime >= intervalMs) {
        lastEmitTime = now;
        yield item;
      }
    }
  };
}

/**
 * Buffer operator: Collects emitted values into arrays until either `count` items
 * are collected or `timeSpanMs` milliseconds have elapsed.
 */
export function buffer<T>(count: number, timeSpanMs?: number): Operator<T, T[]> {
  return async function* (source: AsyncIterable<T>): AsyncIterable<T[]> {
    let currentBuffer: T[] = [];
    let timer: NodeJS.Timeout | null = null;
    let resolveFlush: ((buf: T[]) => void) | null = null;

    if (timeSpanMs && timeSpanMs > 0) {
      timer = setInterval(() => {
        if (currentBuffer.length > 0 && resolveFlush) {
          const chunk = currentBuffer;
          currentBuffer = [];
          const cb = resolveFlush;
          resolveFlush = null;
          cb(chunk);
        }
      }, timeSpanMs);
    }

    try {
      for await (const item of source) {
        currentBuffer.push(item);
        if (currentBuffer.length >= count) {
          const chunk = currentBuffer;
          currentBuffer = [];
          yield chunk;
        }
      }
      if (currentBuffer.length > 0) {
        yield currentBuffer;
      }
    } finally {
      if (timer) clearInterval(timer);
    }
  };
}

/**
 * Fluent wrapper for reactive event stream pipelines.
 */
export class ReactiveEventStream<T> implements AsyncIterable<T> {
  private source: AsyncIterable<T>;

  constructor(source: AsyncIterable<T>) {
    this.source = source;
  }

  static from<T>(source: AsyncIterable<T> | EventStream<T>): ReactiveEventStream<T> {
    return new ReactiveEventStream(source);
  }

  filter(predicate: (item: T) => boolean | Promise<boolean>): ReactiveEventStream<T> {
    return new ReactiveEventStream(filter(predicate)(this.source));
  }

  map<R>(project: (item: T) => R | Promise<R>): ReactiveEventStream<R> {
    return new ReactiveEventStream(map(project)(this.source));
  }

  debounce(waitMs: number): ReactiveEventStream<T> {
    return new ReactiveEventStream(debounce<T>(waitMs)(this.source));
  }

  throttle(intervalMs: number): ReactiveEventStream<T> {
    return new ReactiveEventStream(throttle<T>(intervalMs)(this.source));
  }

  buffer(count: number, timeSpanMs?: number): ReactiveEventStream<T[]> {
    return new ReactiveEventStream(buffer<T>(count, timeSpanMs)(this.source));
  }

  async forEach(callback: (item: T) => void | Promise<void>): Promise<void> {
    for await (const item of this.source) {
      await callback(item);
    }
  }

  async toArray(): Promise<T[]> {
    const results: T[] = [];
    for await (const item of this.source) {
      results.push(item);
    }
    return results;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this.source[Symbol.asyncIterator]();
  }
}
