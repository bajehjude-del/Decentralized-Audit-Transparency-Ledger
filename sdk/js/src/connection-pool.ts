/**
 * Issue #392 — Connection Pooling for High-Throughput Scenarios
 *
 * Implements connection pooling with configurable pool size, acquisition timeouts,
 * health verification, idle timeout eviction, and automatic release.
 */

import { SDKMetricsCollector, sdkMetrics } from './metrics';

export interface ConnectionPoolOptions {
  /** Maximum number of concurrent connections (default: 10) */
  maxConnections?: number;
  /** Minimum number of idle connections to maintain (default: 2) */
  minConnections?: number;
  /** Milliseconds to wait before timing out connection acquisition (default: 5000ms) */
  acquireTimeoutMs?: number;
  /** Milliseconds an unused connection remains alive in pool before eviction (default: 30000ms) */
  idleTimeoutMs?: number;
  /** Factory to create new connection instances */
  factory?: () => Promise<PooledConnectionResource>;
  /** Metrics collector */
  metrics?: SDKMetricsCollector;
}

export interface PooledConnectionResource {
  id: string;
  isHealthy(): Promise<boolean>;
  close(): Promise<void>;
}

class DefaultConnectionResource implements PooledConnectionResource {
  readonly id: string;
  private closed = false;

  constructor(id: string) {
    this.id = id;
  }

  async isHealthy(): Promise<boolean> {
    return !this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

interface PoolEntry {
  resource: PooledConnectionResource;
  lastUsedAt: number;
}

export class ConnectionPool {
  private maxConnections: number;
  private minConnections: number;
  private acquireTimeoutMs: number;
  private idleTimeoutMs: number;
  private factory: () => Promise<PooledConnectionResource>;
  private metrics: SDKMetricsCollector;

  private available: PoolEntry[] = [];
  private inUse: Set<PooledConnectionResource> = new Set();
  private waitQueue: Array<{
    resolve: (conn: PooledConnectionResource) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private counter = 0;
  private isDestroyed = false;

  constructor(options: ConnectionPoolOptions = {}) {
    this.maxConnections = Math.max(1, options.maxConnections ?? 10);
    this.minConnections = Math.max(0, options.minConnections ?? 2);
    this.acquireTimeoutMs = Math.max(100, options.acquireTimeoutMs ?? 5000);
    this.idleTimeoutMs = Math.max(1000, options.idleTimeoutMs ?? 30000);
    this.metrics = options.metrics ?? sdkMetrics;
    this.factory = options.factory ?? (async () => new DefaultConnectionResource(`conn_${++this.counter}`));

    this.metrics.setGauge('pool_max_connections', this.maxConnections);
  }

  /**
   * Acquire a connection from the pool.
   */
  async acquire(): Promise<PooledConnectionResource> {
    if (this.isDestroyed) {
      throw new Error('Connection pool has been destroyed.');
    }

    this.metrics.increment('pool_acquire_requests');

    // 1. Check available idle connections
    while (this.available.length > 0) {
      const entry = this.available.pop()!;
      const isHealthy = await entry.resource.isHealthy().catch(() => false);
      const isExpired = Date.now() - entry.lastUsedAt > this.idleTimeoutMs;

      if (isHealthy && !isExpired) {
        this.inUse.add(entry.resource);
        this.updateGauges();
        return entry.resource;
      } else {
        await entry.resource.close().catch(() => {});
        this.metrics.increment('pool_connections_evicted');
      }
    }

    // 2. If under limit, spin up a new connection
    if (this.totalConnections < this.maxConnections) {
      const resource = await this.factory();
      this.inUse.add(resource);
      this.updateGauges();
      return resource;
    }

    // 3. Otherwise queue request with acquire timeout
    return new Promise<PooledConnectionResource>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waitQueue.findIndex((w) => w.resolve === resolve);
        if (index !== -1) {
          this.waitQueue.splice(index, 1);
          this.metrics.increment('pool_acquire_timeouts');
          reject(new Error(`Timed out waiting for connection after ${this.acquireTimeoutMs}ms`));
        }
      }, this.acquireTimeoutMs);

      this.waitQueue.push({ resolve, reject, timer });
      this.updateGauges();
    });
  }

  /**
   * Release a previously acquired connection back to the pool.
   */
  release(connection: PooledConnectionResource): void {
    if (!this.inUse.has(connection)) {
      return;
    }

    this.inUse.delete(connection);
    this.metrics.increment('pool_releases');

    if (this.isDestroyed) {
      void connection.close();
      return;
    }

    // Check waiting consumers
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      clearTimeout(next.timer);
      this.inUse.add(connection);
      this.updateGauges();
      next.resolve(connection);
      return;
    }

    // Put back into available list
    this.available.push({
      resource: connection,
      lastUsedAt: Date.now(),
    });

    this.updateGauges();
  }

  /**
   * Execute an operation with an acquired connection, guaranteeing automatic release.
   */
  async withConnection<T>(fn: (connection: PooledConnectionResource) => Promise<T>): Promise<T> {
    const conn = await this.acquire();
    try {
      return await fn(conn);
    } finally {
      this.release(conn);
    }
  }

  get totalConnections(): number {
    return this.available.length + this.inUse.size;
  }

  get idleCount(): number {
    return this.available.length;
  }

  get activeCount(): number {
    return this.inUse.size;
  }

  get waitingCount(): number {
    return this.waitQueue.length;
  }

  private updateGauges(): void {
    this.metrics.setGauge('pool_active_connections', this.inUse.size);
    this.metrics.setGauge('pool_idle_connections', this.available.length);
    this.metrics.setGauge('pool_waiting_requests', this.waitQueue.length);
  }

  /**
   * Drain and close all connections in pool.
   */
  async destroy(): Promise<void> {
    this.isDestroyed = true;
    for (const w of this.waitQueue) {
      clearTimeout(w.timer);
      w.reject(new Error('Connection pool is being destroyed.'));
    }
    this.waitQueue = [];

    const toClose = [...this.available.map((e) => e.resource), ...Array.from(this.inUse)];
    this.available = [];
    this.inUse.clear();

    await Promise.all(toClose.map((c) => c.close().catch(() => {})));
    this.updateGauges();
  }
}
