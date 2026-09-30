# Disaster Recovery

Procedures for backing up, restoring, and maintaining the availability of the AuditLedger system. This document covers the on-chain contract state, off-chain services, and the tooling that connects them.

For the GitOps deployment workflow that manages the off-chain services described here, see [docs/gitops-workflow.md](gitops-workflow.md). All Kubernetes deployments are reconciled from Git via ArgoCD, so recovering a service is a matter of restoring the desired state in the GitOps repository and letting the controller reconcile it.

---

## Overview

AuditLedger has two distinct recovery domains:

| Domain | What it covers | Primary risk |
|--------|---------------|--------------|
| **On-chain state** | Contract event log, configuration, ownership | Accidental contract upgrade/migration to new ID, loss of owner key, chain-level incident |
| **Off-chain services** | REST/GraphQL APIs, WebSocket stream, metrics exporter, bridge relayer, UI, Prometheus/Grafana | Host failure, bad deployment, Docker volume loss |
| **GitOps state** | Kubernetes manifests, Helm charts, Kustomize overlays, ArgoCD Applications | Drift from desired state, bad image promotion, lost cluster |

Because the Stellar ledger is itself a distributed, replicated database, on-chain event data is never truly "lost" as long as the chain is live. The goal of on-chain backup is to maintain a portable, verifiable snapshot that can be replayed onto a replacement contract if the original contract ID becomes unusable.

> **Note:** The Docker Compose procedures below remain valid for local development and single-host deployments. Production deployments are managed by ArgoCD from the `gitops/` repository; see [docs/gitops-workflow.md](gitops-workflow.md) for the reconciliation, promotion, and rollback workflow.

---

## 1. Backup Procedures

### 1.1 What to back up

| Artifact | Location | Tool |
|----------|----------|------|
| Contract event snapshot (JSON) | `tools/backup/` | `backup.sh` |
| Contract configuration | derived from event snapshot | `backup.sh` |
| Owner keypair | secure key store (hardware wallet / secrets manager) | manual |
| `.env` / environment variables | deployment secrets store | manual |
| Grafana dashboards | `monitoring/grafana/dashboards/` | git / volume backup |
| Prometheus data | Docker volume `prometheus_data` | volume snapshot |
| Docker Compose configuration | `docker-compose.yml` | git |
| GitOps repository (manifests, charts, overlays) | `gitops/` | git |
| ArgoCD Application definitions | `gitops/apps/` | git |

### 1.2 Event snapshot backup

The `tools/backup/backup.sh` script exports all on-chain events into a JSON file. Configure it via `tools/backup/config.json` before running.

```bash
# Edit tools/backup/config.json with your contract details
# then run:
./tools/backup/backup.sh \
  --config tools/backup/config.json \
  --output ./backups/audit-ledger-$(date +%Y%m%d).json
```

To upload the snapshot to S3 immediately after export:

```bash
./tools/backup/backup.sh \
  --config tools/backup/config.json \
  --s3-upload
```

The output JSON follows this structure:

```json
{
  "backup_timestamp": "2025-06-23T02:00:00Z",
  "contract_id": "CCXMTP7...",
  "block_height": 123456,
  "total_events": 42,
  "events": [
    {
      "index": 0,
      "timestamp": 1719000000,
      "event_type": "payment",
      "submitter": "GB...",
      "metadata": "dHgx"
    }
  ]
}
```

### 1.3 Backup schedule

| Frequency | Trigger | Recommended retention |
|-----------|---------|-----------------------|
| Daily | cron at 02:00 UTC | 30 days local, 1 year S3 |
| Weekly | cron every Sunday 03:00 UTC | 1 year |
| Pre-upgrade | manual, before any `upgrade_contract` call | indefinitely |
| Pre-migration | manual, before deploying a replacement contract | indefinitely |
| Pre-image-promotion | automated, before each GitOps promotion | 90 days |

Automate daily backups with a cron entry on the backup host:

```cron
0 2 * * * /path/to/tools/backup/backup.sh \
  --config /path/to/tools/backup/config.json \
  --s3-upload \
  2>&1 | logger -t audit-ledger-backup
```

### 1.4 Off-chain service backup

Grafana dashboards and Prometheus rules are version-controlled under `monitoring/`. No special backup step is needed beyond keeping the repository up to date.

All Kubernetes manifests, Helm charts, and Kustomize overlays are version-controlled under `gitops/`. Because ArgoCD reconciles the cluster from this repository, the Git history itself is the audit trail and the backup for deployment configuration. Ensure the `gitops/` repository is mirrored to a second remote (e.g., a self-hosted Git server) so a loss of the primary Git host does not block recovery.

For Prometheus historical metric data (Docker volume):

```bash
# Create a volume snapshot
docker run --rm \
  -v audit_prometheus_data:/data \
  -v "$(pwd)/backups":/backup \
  alpine tar czf /backup/prometheus-$(date +%Y%m%d).tar.gz -C /data .
```

For the bridge relayer's local event cache (if running with a persistent volume):

```bash
docker run --rm \
  -v audit_relayer_cache:/data \
  -v "$(pwd)/backups":/backup \
  alpine tar czf /backup/relayer-cache-$(date +%Y%m%d).tar.gz -C /data .
```

### 1.5 Key and secret backup

Owner keypairs and deployment secrets are the most critical assets. Store them in at least two of:

- Hardware wallet (recommended for mainnet owner key)
- Cloud secrets manager (AWS Secrets Manager, HashiCorp Vault, or equivalent)
- Encrypted offline backup (GPG-encrypted file in a secure physical location)

Never store secret keys in version control, plaintext files, or the `tools/backup/config.json` file that is committed to the repo.

---

## 2. Recovery Procedures

### 2.1 Verify a backup before restoring

Always verify a backup against the live contract before treating it as authoritative:

```bash
./tools/backup/verify.sh \
  --backup ./backups/audit-ledger-20250623.json \
  --config tools/backup/config.json
```

The script compares event counts and spot-checks individual event fields. A `STATUS: PASS` result means the backup accurately reflects on-chain state.

### 2.2 Scenario A — Contract still live, partial data loss in off-chain index

If off-chain services (API, indexer) lost their cached state but the Stellar contract is intact:

1. Restart the affected service. Off-chain services read directly from the contract via Soroban RPC and rebuild their state on startup.
2. If the service has its own local cache, clear it and allow it to resync:

```bash
# Example: restart the REST API and clear its event cache
docker compose stop rest
docker volume rm audit_rest_cache 2>/dev/null || true
docker compose up -d rest
```

3. Confirm the service is healthy by querying it:

```bash
curl http://localhost:3002/events?limit=5
```

### 2.3 Scenario B — Contract replaced or migrated to a new contract ID

Use this procedure when:
- The original contract was upgraded in a breaking way and a fresh contract is needed.
- The contract ID changed due to a redeployment.
- You need to migrate to a new network (e.g., testnet → mainnet).

Steps:

1. Deploy and initialize the new contract (see [docs/deployment.md](deployment.md)):

```bash
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/audit_ledger.wasm \
  --source "$SOROBAN_SECRET_KEY" \
  --network testnet

soroban contract invoke \
  --id "$NEW_CONTRACT_ID" \
  --source "$SOROBAN_SECRET_KEY" \
  --network testnet \
  -- initialize \
  --owner <owner_public_key> \
  --global_max_logs 1000000
```

2. Set `global_max_logs` high enough to accommodate all events in the backup:

```bash
TOTAL=$(jq '.total_events' ./backups/audit-ledger-latest.json)
soroban contract invoke \
  --id "$NEW_CONTRACT_ID" \
  --source "$SOROBAN_SECRET_KEY" \
  --network testnet \
  -- set_global_max_logs \
  --caller <owner_public_key> \
  --new_max $((TOTAL + 10000))
```

3. Replay the backup onto the new contract:

```bash
# Preview first
./tools/backup/restore.sh \
  --backup ./backups/audit-ledger-latest.json \
  --config tools/backup/config.json \
  --dry-run

# Apply
./tools/backup/restore.sh \
  --backup ./backups/audit-ledger-latest.json \
  --config tools/backup/config.json
```

4. Verify the restored data:

```bash
./tools/backup/verify.sh \
  --backup ./backups/audit-ledger-latest.json \
  --config tools/backup/config.json
```

5. Update `CONTRACT_ID` in `.env` and restart all off-chain services:

```bash
sed -i "s/CONTRACT_ID=.*/CONTRACT_ID=$NEW_CONTRACT_ID/" .env
docker compose down && docker compose up -d
```

### 2.4 Scenario C — Owner key compromised or lost

If the owner key is compromised but the contract is still live:

1. **Immediately** call `transfer_ownership` from the current owner key to a new, safe key:

```bash
soroban contract invoke \
  --id "$CONTRACT_ID" \
  --source "$COMPROMISED_SECRET_KEY" \
  --network mainnet \
  -- transfer_ownership \
  --caller <current_owner_address> \
  --new_owner <new_owner_address>
```

2. Revoke the compromised key from all signing services, secrets managers, and CI/CD pipelines.

3. Rotate all secrets in `.env` and redeploy off-chain services.

If the owner key is lost entirely (no backup), the contract governance functions become inaccessible. The event log remains readable and append-only operations by authorized submitters continue. To regain governance, a new contract must be deployed and data migrated per Scenario B above.

### 2.5 Scenario D — Off-chain service host failure

All off-chain services run as Docker containers defined in `docker-compose.yml`. On a new host:

For Kubernetes deployments managed by ArgoCD, a host failure is handled by the cluster itself: the ReplicaSet controller reschedules pods onto healthy nodes. If the entire cluster is lost, re-create it and point ArgoCD at the `gitops/` repository; the controller will restore every service to the desired state recorded in Git. See [docs/gitops-workflow.md](gitops-workflow.md#disaster-recovery) for the full cluster-rebuild procedure.

1. Install prerequisites: Docker, Docker Compose, Node.js 20+.
2. Clone the repository and copy secrets:

```bash
git clone <repo_url>
cd Decentralized-Audit-Transparency-Ledger
cp .env.example .env
# populate .env with CONTRACT_ID, RPC_URL, and other required values
```

3. Start the full stack:

```bash
docker compose up --build -d
```

4. Restore Prometheus historical data from backup (optional):

```bash
docker compose stop prometheus
docker run --rm \
  -v audit_prometheus_data:/data \
  -v "$(pwd)/backups":/backup \
  alpine sh -c "cd /data && tar xzf /backup/prometheus-latest.tar.gz"
docker compose start prometheus
```

Data that is missing from the Prometheus backup will simply show a gap in Grafana dashboards; the contract state itself is unaffected.

---

## 3. Failover Procedures

### 3.1 RPC endpoint failover

The `RPC_URL` environment variable controls which Soroban RPC node all off-chain services connect to. If the primary endpoint becomes unreachable, update `.env` and restart services:

| Network | Primary RPC | Fallback RPC |
|---------|------------|--------------|
| Testnet | `https://soroban-testnet.stellar.org` | `https://rpc-futurenet.stellar.org` (different net, for testing only) |
| Mainnet | `https://soroban-mainnet.stellar.org` | Community / self-hosted Horizon + Soroban RPC |

To switch the active RPC endpoint:

```bash
# Update .env
sed -i 's|RPC_URL=.*|RPC_URL=https://your-fallback-rpc.example.com|' .env

# Restart all services that read RPC_URL
docker compose restart metrics-exporter rest relayer
```

If you operate a self-hosted Soroban RPC node, configure it to point at a Stellar Core node on the same network and update `RPC_URL` accordingly.

### 3.2 API service failover

Each off-chain API service (REST, GraphQL, WebSocket) is stateless — it reads from the contract on demand and holds no durable state of its own. Any replica started with the same `CONTRACT_ID` and `RPC_URL` will serve correct responses immediately.

To run a hot standby for the REST API:

```bash
# Start a second REST instance on a different port
docker compose -f docker-compose.yml run -d -p 3012:3002 --name rest-standby rest
```

Update your load balancer or reverse proxy (nginx, Caddy, etc.) to route traffic to the standby instance if the primary health check fails.

### 3.3 Bridge relayer failover

The bridge relayer (`bridge/relayer`) maintains a local event cache to avoid re-submitting proofs. If the primary relayer goes down:

1. Start a standby relayer instance pointed at the same contract:

```bash
docker compose run -d --name relayer-standby relayer
```

2. The standby will re-scan from the last confirmed on-chain proof submission. There may be a brief period where proofs are re-submitted (the EVM verifier contract is idempotent and will reject duplicates gracefully).

3. Once the standby is confirmed healthy, decommission the failed primary.

### 3.4 Multi-region deployment

For production systems requiring high availability across regions, deploy the off-chain stack to at least two regions and configure:

When using ArgoCD, register each regional cluster as a separate ArgoCD cluster and use ApplicationSets to fan out the same `gitops/` manifests to every region. Progressive delivery (canary or blue-green) is configured per Application via Argo Rollouts; see [docs/gitops-workflow.md](gitops-workflow.md#progressive-delivery).

- A global load balancer (e.g., AWS Route 53 + ALB, Cloudflare) with health-check-based failover.
- Shared secrets stored in a replicated secrets manager (e.g., AWS Secrets Manager with cross-region replication).
- A single active bridge relayer with a warm standby in the second region (active-passive to avoid duplicate proof submissions).
- Prometheus remote write to a central time-series store (e.g., Thanos, Cortex, or a managed offering) so metrics survive single-region failure.

The Stellar network itself provides global redundancy; no special cross-region setup is needed for the on-chain contract.

---

## 4. Testing Procedures

Disaster recovery documentation is only useful if the procedures actually work. Run these tests on a regular schedule — at least quarterly — and before any major deployment or infrastructure change.

### 4.1 Backup integrity test

Verify that the most recent scheduled backup is consistent with the live contract:

```bash
# Find the latest backup
LATEST=$(ls -t ./backups/audit-ledger-*.json | head -1)

# Verify it
./tools/backup/verify.sh \
  --backup "$LATEST" \
  --config tools/backup/config.json

# Expected output: STATUS: PASS
```

Automate this check as a weekly cron job that alerts on failure:

```cron
0 6 * * 0 /path/to/tools/backup/verify.sh \
  --backup "$(ls -t /path/to/backups/audit-ledger-*.json | head -1)" \
  --config /path/to/tools/backup/config.json \
  || curl -X POST "$SLACK_WEBHOOK" -d '{"text":"ALERT: AuditLedger backup verification FAILED"}'
```

### 4.2 Restore drill (testnet)

Run a full restore drill against the Stellar testnet at least once per quarter:

```bash
# 1. Deploy a fresh contract to testnet
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/audit_ledger.wasm \
  --source "$SOROBAN_SECRET_KEY" \
  --network testnet

# 2. Initialize it
soroban contract invoke \
  --id "$DRILL_CONTRACT_ID" \
  --source "$SOROBAN_SECRET_KEY" \
  --network testnet \
  -- initialize \
  --owner <owner_public_key> \
  --global_max_logs 1000000

# 3. Restore the latest backup
./tools/backup/restore.sh \
  --backup "$(ls -t ./backups/audit-ledger-*.json | head -1)" \
  --config tools/backup/drill-config.json   # points to DRILL_CONTRACT_ID

# 4. Verify the restore was complete
./tools/backup/verify.sh \
  --backup "$(ls -t ./backups/audit-ledger-*.json | head -1)" \
  --config tools/backup/drill-config.json

# 5. Record the result and decommission the drill contract
```

Keep a `tools/backup/drill-config.json` that mirrors `config.json` but with `contract_id` set to the drill contract. Never run restore drills against your production contract.

### 4.3 RPC failover test

Verify that services recover gracefully when the primary RPC endpoint is unavailable:

```bash
# 1. Point RPC_URL at an invalid endpoint
RPC_URL=https://invalid.rpc.example.com docker compose up -d metrics-exporter

# 2. Confirm the service reports an error (does not silently hang)
sleep 15
docker compose logs metrics-exporter | grep -i "error\|fail\|unreachable"

# 3. Restore the real endpoint
docker compose stop metrics-exporter
sed -i 's|RPC_URL=.*|RPC_URL=https://soroban-testnet.stellar.org|' .env
docker compose up -d metrics-exporter

# 4. Confirm metrics resume within one scrape interval (default 15 s)
sleep 20
curl -s http://localhost:9091/metrics | grep audit_ledger_total_events
```

### 4.4 Off-chain service recovery test

Simulate a full service host failure and recovery:

```bash
# 1. Capture current state
BEFORE=$(curl -s http://localhost:3002/events | jq '.total')

# 2. Destroy all running containers and volumes
docker compose down -v

# 3. Recover from scratch (simulates new host)
docker compose up --build -d

# 4. Wait for services to start (adjust sleep as needed)
sleep 30

# 5. Confirm state is consistent
AFTER=$(curl -s http://localhost:3002/events | jq '.total')
echo "Before: $BEFORE  After: $AFTER"
[ "$BEFORE" = "$AFTER" ] && echo "PASS" || echo "FAIL: event count mismatch"
```

Because the REST API reads state directly from the Soroban RPC on each request, the event count should match immediately after restart with no data migration needed.

### 4.5 Owner key rotation test

Practice ownership transfer on testnet before it is needed in an emergency:

```bash
# Generate a new test keypair
soroban config identity generate new-owner-test

NEW_OWNER=$(soroban config identity address new-owner-test)

# Transfer ownership to the new key
soroban contract invoke \
  --id "$CONTRACT_ID" \
  --source "$SOROBAN_SECRET_KEY" \
  --network testnet \
  -- transfer_ownership \
  --caller <current_owner_address> \
  --new_owner "$NEW_OWNER"

# Verify by calling a governance function with the new key
soroban contract invoke \
  --id "$CONTRACT_ID" \
  --source new-owner-test \
  --network testnet \
  -- set_global_max_logs \
  --caller "$NEW_OWNER" \
  --new_max 200000

# Transfer ownership back to the original owner to restore normal state
soroban contract invoke \
  --id "$CONTRACT_ID" \
  --source new-owner-test \
  --network testnet \
  -- transfer_ownership \
  --caller "$NEW_OWNER" \
  --new_owner <original_owner_address>
```

### 4.6 Test schedule

| Test | Frequency | Owner |
|------|-----------|-------|
| Backup integrity verification | Weekly (automated) | On-call engineer |
| Restore drill to testnet | Quarterly | Platform team |
| RPC failover test | Quarterly | Platform team |
| Off-chain service recovery | Quarterly | Platform team |
| Owner key rotation drill | Annually | Security team |
| GitOps rollback drill (revert a bad promotion) | Quarterly | Platform team |
| ArgoCD sync/health verification | Daily (automated) | On-call engineer |

Record the results of each drill in your incident log. If a test fails, file a bug and re-run after the fix before closing the issue.

---

## 5. Comprehensive Disaster Recovery Runbooks

The AuditLedger system provides standardized, auditable operational runbooks under `runbooks/definitions/` and executable via `scripts/runbook-runner.sh`.

### 5.1 RB-005: Contract Upgrade Failure Rollback

- **Trigger**: Transaction reverts, unexpected panics, or broken invariants immediately following contract WASM upgrade.
- **Preconditions**: Previous stable WASM hash recorded in release catalog.
- **Execution**:
  ```bash
  ./scripts/runbook-runner.sh execute contract-upgrade-failure '{"contractAddress": "CCXMTP7..."}'
  ```
- **Step-by-step Procedures**:
  1. **Freeze Contract Ingestion**: Invoke `pause_with_details` to block write operations while preserving read access.
  2. **Storage Layout Validation**: Run `scripts/storage-layout/validate_layout.py` to assert that storage keys were not corrupted.
  3. **WASM Bytecode Rollback**: Invoke `upgrade_contract` passing the previous stable WASM bytecode hash.
  4. **Smoke Diagnostics**: Execute contract test suite verifying event logging and query resolution.
  5. **Unpause & Publish**: Unpause the contract and emit a recovery audit event to notification subscribers.

### 5.2 RB-006: RPC Endpoint Outage & Failover

- **Trigger**: Primary Stellar/Soroban RPC endpoint returns HTTP 5xx or response latency exceeds 3000ms across 3 consecutive probes.
- **Preconditions**: Standby RPC cluster synchronized within 1 ledger.
- **Execution**:
  ```bash
  ./scripts/runbook-runner.sh execute rpc-outage
  ```
- **Step-by-step Procedures**:
  1. **Health Verification**: Active probe confirms primary RPC latency degradation or down state.
  2. **Trip Circuit Breaker**: Client and API connection pools open circuit breakers to prevent cascading timeouts.
  3. **Promote Standby Endpoint**: Update DNS / load balancer target to `rpc-secondary.stellar.org`.
  4. **Ledger Sequence Catchup**: Assert standby RPC returns `latestLedger >= primaryLastKnownLedger`.
  5. **Connection Pool Reset**: Re-initialize SDK and backend connection pools and reset circuit breaker to `CLOSED`.

### 5.3 RB-007: Database Corruption Recovery

- **Trigger**: Database checksum mismatches, WAL corruption, or unrecoverable disk IO errors on off-chain storage replicas.
- **Preconditions**: Verified S3 backup snapshot available within the past 60 minutes.
- **Execution**:
  ```bash
  ./scripts/runbook-runner.sh execute database-corruption
  ```
- **Step-by-step Procedures**:
  1. **Quarantine Node**: Eject the corrupted replica from the load balancer pool.
  2. **Fetch Snapshot**: Download the latest immutable point-in-time snapshot from S3.
  3. **Filesystem Restore**: Verify SHA-256 signature and unpack the snapshot.
  4. **Delta Replay**: Run `scripts/replay.sh` to ingest delta events from Soroban ledger history up to current head.
  5. **Integrity Check & Re-admission**: Verify cryptographic hash-chain across all event records and rejoin the active pool.

### 5.4 RB-004: Bridge Relayer Failure & Leader Failover

- **Trigger**: Cross-chain relayer heartbeat missing for > 120 seconds or transaction queue backlog exceeds threshold.
- **Preconditions**: Secondary relayer synced with EVM / Soroban bridge contracts.
- **Execution**:
  ```bash
  ./scripts/runbook-runner.sh execute bridge-failover
  ```
- **Step-by-step Procedures**:
  1. **Heartbeat Check**: Confirm primary relayer stall and check secondary relayer sync.
  2. **Fencing Lock**: Acquire distributed lock fence preventing split-brain transaction submissions.
  3. **Queue Reconciliation**: Transfer uncommitted in-flight event batches to the backup relayer queue.
  4. **Promote Standby**: Invoke on-chain bridge contract to register the standby relayer address.
  5. **State Root Attestation**: Verify cross-chain Merkle root attestation matches on target network.

### 5.5 RB-008: Monitoring Stack Outage Recovery

- **Trigger**: Prometheus scrape failures for > 5 intervals, Grafana dashboard unavailability, or Alertmanager crash.
- **Preconditions**: Standby monitoring instance or disk spooling capability ready.
- **Execution**:
  ```bash
  ./scripts/runbook-runner.sh execute monitoring-stack-outage
  ```
- **Step-by-step Procedures**:
  1. **Diagnose Pipeline**: Check container status for Prometheus, Grafana, and Metrics Exporter.
  2. **Activate Disk Spooling**: Metrics exporter switches to local disk buffer to prevent telemetry drop.
  3. **Failover Alertmanager**: Route alerts to secondary Alertmanager replica.
  4. **Restart Prometheus**: Recreate Prometheus StatefulSet with clean WAL recovery.
  5. **Drain Spool Buffer**: Flush buffered telemetry into Prometheus and verify nominal metric flow.

---

## 6. Automated Failover Architecture

Automated failover controllers in `tools/failover/automated-failover.ts` and `scripts/automated-failover.sh` monitor infrastructure and switch targets without manual human intervention:

- **RPC Endpoint Failover**: Implements three-state circuit breakers (`CLOSED`, `OPEN`, `HALF_OPEN`) with active HTTP probing. When error rates exceed threshold, traffic switches seamlessly to secondary RPC clusters.
- **API Multi-Region Failover**: In the event of an AWS / GCP regional outage, DNS health routing automatically shifts traffic between `us-east-1` and `eu-central-1`.
- **Metrics Exporter Buffer Spooling**: When Prometheus is unreachable, metrics are spooled to local memory and disk buffers up to 1GB, guaranteeing zero telemetry loss during monitoring outages.

---

## 7. Chaos Engineering Experiments

Chaos experiments test system resilience under controlled fault conditions:

- **Litmus Chaos Scenarios**:
  - `chaos/litmus/rpc-network-latency.yaml`: Injects 4000ms network latency on RPC requests to verify circuit breaker trip and fallback.
  - `chaos/litmus/api-pod-failure.yaml`: Simulates sudden pod crashes to test Kubernetes ReplicaSet auto-healing and load balancer health draining.
- **Chaos Mesh Scenarios**:
  - `chaos/chaos-mesh/rpc-network-partition.yaml`: Partitions RPC network traffic to validate relayer and API failover.
  - `chaos/chaos-mesh/db-io-delay.yaml`: Simulates disk latency spikes on database volumes to verify query timeout protections.

---

## 8. Scheduled Disaster Recovery Drills

Regular drills ensure teams and automated tooling are ready for production incidents:

| Drill Type | Frequency | Scenario | Success Criteria |
|------------|-----------|----------|------------------|
| **WASM Rollback Drill** | Monthly | Revert simulated contract upgrade failure | Complete rollback in < 3 minutes with zero state loss |
| **RPC Outage Simulation** | Bi-weekly | Inject RPC latency via Litmus Chaos | Failover executes in < 15 seconds without dropped events |
| **Database Restore Replay** | Monthly | Restore snapshot and replay 10,000 events | Restored state hash matches ledger head exactly |
| **Bridge Leader Failover** | Quarterly | Kill active bridge relayer process | Standby takes over in < 30 seconds with no nonce collisions |

---

## 9. Runbook Automation (RunWhen & Scripted Execution)

Runbooks can be executed both programmatically and via interactive CLI:

```bash
# List all operational and DR runbooks
./scripts/runbook-runner.sh list

# Validate runbook schema and parameters
./scripts/runbook-runner.sh validate contract-upgrade-failure

# Perform dry-run simulation
./scripts/runbook-runner.sh dry-run rpc-outage

# Execute live automated remediation
./scripts/runbook-runner.sh execute rpc-outage
```

---

## 10. Disaster Recovery Metrics & SLAs

AuditLedger continuously measures disaster recovery readiness using three primary metrics:

| Metric | Target SLA | Description | Measurement Method |
|--------|------------|-------------|--------------------|
| **RTO (Recovery Time Objective)** | **< 5 minutes** | Maximum acceptable duration to restore service availability | Timestamp difference from outage detection to health check nominal |
| **RPO (Recovery Point Objective)** | **0 transactions (on-chain)**<br>**< 60 seconds (off-chain)** | Maximum acceptable data loss window | Delta ledger sequence / missing uncommitted events |
| **MTTR (Mean Time to Recovery)** | **< 15 minutes** | Average time required to diagnose, remediate, and verify recovery | Measured across all simulated drills and live incidents |

DR metrics are aggregated and exposed through `DRMetricsTracker` in `tools/failover/automated-failover.ts` and Grafana disaster recovery dashboards.

---

## Related Documents

- [docs/deployment.md](deployment.md) — deploying and initializing the contract
- [docs/upgrade-guide.md](upgrade-guide.md) — safe contract upgrade procedures
- [docs/architecture.md](architecture.md) — system component overview
- [docs/fees.md](fees.md) — storage costs and TTL configuration
- [tools/backup/README.md](../tools/backup/README.md) — backup script reference
- [docs/gitops-workflow.md](gitops-workflow.md) — GitOps deployment workflow, progressive delivery, and rollback
- [gitops/README.md](../gitops/README.md) — GitOps repository structure and Application definitions

