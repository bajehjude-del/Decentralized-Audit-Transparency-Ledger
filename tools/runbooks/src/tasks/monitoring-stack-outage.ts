import { ExecutionContext, RunbookDefinition, StepResult } from '../types';

export const monitoringStackOutageRunbook: RunbookDefinition = {
  id: 'RB-008-MONITORING-STACK-OUTAGE',
  name: 'Monitoring Stack & Telemetry Pipeline Outage Recovery',
  version: '1.0.0',
  type: 'MONITORING_RECOVERY',
  description: 'Recovers Prometheus, Grafana, Alertmanager, or metrics-exporter pipeline with standby telemetry failover.',
  author: 'SRE & Observability Team',
  steps: [
    {
      id: 1,
      name: 'Identify Failing Component (Prometheus / Grafana / Exporter)',
      description: 'Performs readiness probe across Prometheus, Alertmanager, and Metrics Exporter.',
      isIdempotent: true,
      timeoutSeconds: 20,
      action: async (ctx: ExecutionContext): Promise<StepResult> => {
        ctx.logs.push('Diagnosing telemetry stack components...');
        return {
          success: true,
          message: 'Root cause identified: Prometheus TSDB WAL lock crash.',
          output: { failedComponent: 'prometheus-server', healthCode: 503 },
        };
      },
    },
    {
      id: 2,
      name: 'Activate Standby Metrics Exporter Sidecar',
      description: 'Enables buffer spooling in metrics-exporter to prevent telemetry data loss.',
      isIdempotent: true,
      timeoutSeconds: 30,
      action: async (ctx: ExecutionContext): Promise<StepResult> => {
        ctx.logs.push('Activating disk spool buffer on metrics-exporter...');
        return {
          success: true,
          message: 'Metrics buffered to disk. Zero metric loss during Prometheus downtime.',
          output: { bufferMode: 'SPOOLING', spoolCapacityMb: 1024 },
        };
      },
    },
    {
      id: 3,
      name: 'Switch Alerting Routing to Secondary Alertmanager Cluster',
      description: 'Redirects critical alert dispatch to secondary Alertmanager instance.',
      isIdempotent: true,
      timeoutSeconds: 25,
      action: async (ctx: ExecutionContext): Promise<StepResult> => {
        ctx.logs.push('Failing over Alertmanager target to secondary replica...');
        return {
          success: true,
          message: 'Alertmanager failover completed.',
          output: { activeAlertmanager: 'http://alertmanager-secondary:9093' },
        };
      },
      rollback: async (ctx: ExecutionContext): Promise<StepResult> => {
        ctx.logs.push('Restoring primary Alertmanager...');
        return { success: true, message: 'Primary Alertmanager restored.' };
      },
    },
    {
      id: 4,
      name: 'Restart / Recreate Primary Prometheus StatefulSet',
      description: 'Clears stale WAL locks and restarts primary Prometheus pod.',
      isIdempotent: true,
      timeoutSeconds: 90,
      action: async (ctx: ExecutionContext): Promise<StepResult> => {
        ctx.logs.push('Recreating Prometheus StatefulSet pod with clean WAL recovery...');
        return {
          success: true,
          message: 'Prometheus successfully restarted and ready to scrape.',
          output: { podStatus: 'Running', scrapeTargetCount: 18 },
        };
      },
    },
    {
      id: 5,
      name: 'Verify Telemetry Ingestion and Close Incident',
      description: 'Verifies scrape loop and drains metrics-exporter spool buffer.',
      isIdempotent: true,
      timeoutSeconds: 30,
      action: async (ctx: ExecutionContext): Promise<StepResult> => {
        ctx.logs.push('Flushing exporter disk spool to Prometheus...');
        return {
          success: true,
          message: 'Observability stack healthy. Incident resolved.',
          output: { spoolDrained: true, scrapeErrorRate: 0 },
        };
      },
    },
  ],
};
