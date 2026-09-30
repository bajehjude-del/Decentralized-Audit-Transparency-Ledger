/**
 * Issue #398 — Automated Failover for Critical Services
 *
 * Implements automated failover for RPC endpoints, API services,
 * and metrics exporter with circuit breaker protection, health checking,
 * and disaster recovery metrics tracking (RTO, RPO, MTTR).
 */

export interface EndpointHealth {
  url: string;
  isHealthy: boolean;
  consecutiveFailures: number;
  lastCheckedAt: number;
  latencyMs: number;
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface FailoverEvent {
  service: string;
  previousEndpoint: string;
  newEndpoint: string;
  reason: string;
  timestamp: string;
  downtimeMs: number;
}

export class RPCFailoverManager {
  private primaryUrl: string;
  private standbyUrls: string[];
  private activeUrl: string;
  private circuitState: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private failureThreshold: number;
  private failoverHistory: FailoverEvent[] = [];
  private outageStartTime: number | null = null;

  constructor(options: {
    primaryUrl: string;
    standbyUrls: string[];
    failureThreshold?: number;
  }) {
    this.primaryUrl = options.primaryUrl;
    this.standbyUrls = options.standbyUrls;
    this.activeUrl = options.primaryUrl;
    this.failureThreshold = options.failureThreshold ?? 3;
  }

  getActiveEndpoint(): string {
    return this.activeUrl;
  }

  getCircuitState(): CircuitState {
    return this.circuitState;
  }

  recordProbeSuccess(latencyMs: number): void {
    this.consecutiveFailures = 0;
    if (this.circuitState === 'HALF_OPEN') {
      this.circuitState = 'CLOSED';
    }
  }

  recordProbeFailure(reason: string): { failedOver: boolean; newEndpoint?: string } {
    this.consecutiveFailures++;
    if (this.outageStartTime === null) {
      this.outageStartTime = Date.now();
    }

    if (this.consecutiveFailures >= this.failureThreshold) {
      this.circuitState = 'OPEN';
      const prev = this.activeUrl;
      const next = this.standbyUrls.find((u) => u !== prev) || this.primaryUrl;

      if (next !== prev) {
        this.activeUrl = next;
        const downtimeMs = this.outageStartTime ? Date.now() - this.outageStartTime : 0;
        this.outageStartTime = null;

        const event: FailoverEvent = {
          service: 'Stellar-RPC',
          previousEndpoint: prev,
          newEndpoint: next,
          reason,
          timestamp: new Date().toISOString(),
          downtimeMs,
        };
        this.failoverHistory.push(event);
        return { failedOver: true, newEndpoint: next };
      }
    }

    return { failedOver: false };
  }

  getHistory(): FailoverEvent[] {
    return this.failoverHistory;
  }
}

export class APIFailoverManager {
  private activeRegion: string = 'us-east-1';
  private standbyRegion: string = 'eu-central-1';
  private inFailover = false;

  triggerFailover(reason: string): { activeRegion: string; switched: boolean } {
    if (this.inFailover) {
      return { activeRegion: this.activeRegion, switched: false };
    }

    const prev = this.activeRegion;
    this.activeRegion = this.standbyRegion;
    this.standbyRegion = prev;
    this.inFailover = true;

    return { activeRegion: this.activeRegion, switched: true };
  }

  restorePrimary(): void {
    this.inFailover = false;
  }

  getActiveRegion(): string {
    return this.activeRegion;
  }
}

export class MetricsExporterFailoverManager {
  private spooling = false;
  private primaryPrometheusTarget: string;
  private secondaryPrometheusTarget: string;
  private activeTarget: string;

  constructor(primary: string, secondary: string) {
    this.primaryPrometheusTarget = primary;
    this.secondaryPrometheusTarget = secondary;
    this.activeTarget = primary;
  }

  handlePrometheusOutage(): { mode: 'SPOOLING_TO_DISK' | 'FAILED_OVER'; activeTarget: string } {
    this.spooling = true;
    this.activeTarget = this.secondaryPrometheusTarget;
    return {
      mode: 'FAILED_OVER',
      activeTarget: this.activeTarget,
    };
  }

  handlePrometheusRecovery(): { mode: 'DIRECT'; activeTarget: string } {
    this.spooling = false;
    this.activeTarget = this.primaryPrometheusTarget;
    return {
      mode: 'DIRECT',
      activeTarget: this.activeTarget,
    };
  }

  isSpooling(): boolean {
    return this.spooling;
  }
}

export class DRMetricsTracker {
  private incidents: Array<{
    scenario: string;
    rtoSeconds: number;
    rpoLedgers: number;
    mttrMinutes: number;
    timestamp: string;
  }> = [];

  recordIncident(scenario: string, rtoSeconds: number, rpoLedgers: number, mttrMinutes: number): void {
    this.incidents.push({
      scenario,
      rtoSeconds,
      rpoLedgers,
      mttrMinutes,
      timestamp: new Date().toISOString(),
    });
  }

  getMetricsSummary(): {
    totalIncidents: number;
    averageRtoSeconds: number;
    averageRpoLedgers: number;
    averageMttrMinutes: number;
  } {
    if (this.incidents.length === 0) {
      return {
        totalIncidents: 0,
        averageRtoSeconds: 0,
        averageRpoLedgers: 0,
        averageMttrMinutes: 0,
      };
    }

    const count = this.incidents.length;
    const avgRto = this.incidents.reduce((a, b) => a + b.rtoSeconds, 0) / count;
    const avgRpo = this.incidents.reduce((a, b) => a + b.rpoLedgers, 0) / count;
    const avgMttr = this.incidents.reduce((a, b) => a + b.mttrMinutes, 0) / count;

    return {
      totalIncidents: count,
      averageRtoSeconds: avgRto,
      averageRpoLedgers: avgRpo,
      averageMttrMinutes: avgMttr,
    };
  }
}
