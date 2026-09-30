/**
 * EventBusMetricsReporter
 *
 * Exposes Prometheus-compatible metrics for the event bus. Attaches to an
 * IEventBus instance and scrapes metrics on demand via a lightweight HTTP
 * server at /metrics.
 *
 * Exposed metrics:
 *   event_bus_published_total        — Total messages published
 *   event_bus_delivered_total        — Total successful handler invocations
 *   event_bus_failed_total           — Total failed deliveries (after retries)
 *   event_bus_dlq_size               — Current dead-letter queue depth
 *   event_bus_active_subscriptions   — Number of active subscriptions
 *   event_bus_publish_duration_ms    — Histogram of publish latency (ms)
 *   event_bus_delivery_duration_ms   — Histogram of per-handler latency (ms)
 *
 * Usage:
 *   const reporter = new EventBusMetricsReporter(bus, { port: 9102 });
 *   reporter.start();
 *   // …
 *   reporter.stop();
 */

import http from "http";
import type { IEventBus, EventBusMetrics } from "./types";

// ── Config ────────────────────────────────────────────────────────────────────

export interface MetricsReporterConfig {
  /** Port to bind the HTTP server to. Default: 9102 */
  port?: number;
  /** Hostname to bind. Default: '0.0.0.0' */
  host?: string;
  /** Path to serve metrics at. Default: '/metrics' */
  path?: string;
  /** Interval in ms at which timing histograms are snapshotted. Default: 15_000 */
  scrapeIntervalMs?: number;
}

// ── Prometheus primitives ─────────────────────────────────────────────────────

type Labels = Record<string, string>;

function renderLabels(labels: Labels): string {
  const pairs = Object.entries(labels)
    .map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",");
  return pairs.length > 0 ? `{${pairs}}` : "";
}

class Counter {
  private values: Map<string, number> = new Map();
  constructor(
    private readonly name: string,
    private readonly help: string,
  ) {}
  inc(labels: Labels = {}, amount = 1): void {
    const key = JSON.stringify(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }
  render(): string {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    for (const [labelJson, value] of this.values) {
      const labels: Labels = JSON.parse(labelJson);
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines.join("\n");
  }
}

class Gauge {
  private value = 0;
  constructor(
    private readonly name: string,
    private readonly help: string,
  ) {}
  set(value: number): void {
    this.value = value;
  }
  render(): string {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
      `${this.name} ${this.value}`,
    ].join("\n");
  }
}

/** Simplified fixed-bucket histogram (no native prom-client dependency). */
class Histogram {
  private buckets: Map<number, number> = new Map();
  private sum = 0;
  private count = 0;
  private readonly thresholds: number[];

  constructor(
    private readonly name: string,
    private readonly help: string,
    thresholds: number[] = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000],
  ) {
    this.thresholds = [...thresholds].sort((a, b) => a - b);
    for (const t of this.thresholds) this.buckets.set(t, 0);
  }

  observe(value: number): void {
    this.sum += value;
    this.count++;
    for (const threshold of this.thresholds) {
      if (value <= threshold) {
        this.buckets.set(threshold, (this.buckets.get(threshold) ?? 0) + 1);
      }
    }
  }

  render(): string {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    let cumulative = 0;
    for (const threshold of this.thresholds) {
      cumulative += this.buckets.get(threshold) ?? 0;
      lines.push(`${this.name}_bucket{le="${threshold}"} ${cumulative}`);
    }
    lines.push(`${this.name}_bucket{le="+Inf"} ${this.count}`);
    lines.push(`${this.name}_sum ${this.sum}`);
    lines.push(`${this.name}_count ${this.count}`);
    return lines.join("\n");
  }
}

// ── EventBusMetricsReporter ───────────────────────────────────────────────────

export class EventBusMetricsReporter {
  private readonly config: Required<MetricsReporterConfig>;
  private server: http.Server | null = null;

  // Prometheus metrics
  private readonly publishedTotal = new Counter(
    "event_bus_published_total",
    "Total number of messages published to the event bus",
  );
  private readonly deliveredTotal = new Counter(
    "event_bus_delivered_total",
    "Total number of successful handler invocations",
  );
  private readonly failedTotal = new Counter(
    "event_bus_failed_total",
    "Total number of failed deliveries after all retry attempts",
  );
  private readonly dlqSize = new Gauge(
    "event_bus_dlq_size",
    "Current number of entries in the dead-letter queue",
  );
  private readonly activeSubscriptions = new Gauge(
    "event_bus_active_subscriptions",
    "Current number of active subscriptions on the event bus",
  );
  private readonly publishDuration = new Histogram(
    "event_bus_publish_duration_ms",
    "Publish operation latency in milliseconds",
  );
  private readonly deliveryDuration = new Histogram(
    "event_bus_delivery_duration_ms",
    "Per-handler delivery latency in milliseconds",
  );

  /** Snapshot of the last-scraped bus metrics for delta calculation. */
  private lastSnapshot: EventBusMetrics | null = null;
  private scrapeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly bus: IEventBus,
    config: MetricsReporterConfig = {},
  ) {
    this.config = {
      port: config.port ?? 9102,
      host: config.host ?? "0.0.0.0",
      path: config.path ?? "/metrics",
      scrapeIntervalMs: config.scrapeIntervalMs ?? 15_000,
    };

    // Wire into the bus EventEmitter for timing data
    this.wireTimingHooks();
  }

  // ── Timing hooks ────────────────────────────────────────────────────────────

  /**
   * Patches the bus to record publish and delivery durations.
   * We wrap the bus's publish method non-destructively.
   */
  private wireTimingHooks(): void {
    const originalPublish = this.bus.publish.bind(this.bus);

    this.bus.publish = async (message) => {
      const start = performance.now();
      await originalPublish(message);
      this.publishDuration.observe(performance.now() - start);
    };
  }

  // ── Scraping ────────────────────────────────────────────────────────────────

  /**
   * Reads the current metrics snapshot from the bus and updates gauges/counters.
   */
  private scrape(): void {
    const current = this.bus.getMetrics();

    // Update deltas for counters
    if (this.lastSnapshot) {
      const publishedDelta = current.published - this.lastSnapshot.published;
      const deliveredDelta = current.delivered - this.lastSnapshot.delivered;
      const failedDelta = current.failed - this.lastSnapshot.failed;

      if (publishedDelta > 0) this.publishedTotal.inc({}, publishedDelta);
      if (deliveredDelta > 0) this.deliveredTotal.inc({}, deliveredDelta);
      if (failedDelta > 0) this.failedTotal.inc({}, failedDelta);
    } else {
      // First scrape — use absolute values
      if (current.published > 0) this.publishedTotal.inc({}, current.published);
      if (current.delivered > 0) this.deliveredTotal.inc({}, current.delivered);
      if (current.failed > 0) this.failedTotal.inc({}, current.failed);
    }

    this.dlqSize.set(current.dlqSize);
    this.activeSubscriptions.set(current.activeSubscriptions);

    this.lastSnapshot = current;
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  /**
   * Renders all metrics in Prometheus text exposition format.
   */
  renderMetrics(): string {
    this.scrape();
    return [
      this.publishedTotal.render(),
      this.deliveredTotal.render(),
      this.failedTotal.render(),
      this.dlqSize.render(),
      this.activeSubscriptions.render(),
      this.publishDuration.render(),
      this.deliveryDuration.render(),
    ].join("\n\n") + "\n";
  }

  // ── Server lifecycle ────────────────────────────────────────────────────────

  /**
   * Starts the metrics HTTP server and periodic scrape interval.
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.url === this.config.path || req.url === this.config.path + "?") {
          res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
          res.end(this.renderMetrics());
        } else {
          res.writeHead(404);
          res.end("Not found");
        }
      });

      this.server.on("error", reject);

      this.server.listen(this.config.port, this.config.host, () => {
        console.log(
          `[event-bus-metrics] Prometheus metrics available at ` +
          `http://${this.config.host}:${this.config.port}${this.config.path}`,
        );

        // Start periodic background scrape
        this.scrapeTimer = setInterval(
          () => this.scrape(),
          this.config.scrapeIntervalMs,
        );

        resolve();
      });
    });
  }

  /**
   * Stops the HTTP server and clears the scrape interval.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.scrapeTimer) {
        clearInterval(this.scrapeTimer);
        this.scrapeTimer = null;
      }

      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
