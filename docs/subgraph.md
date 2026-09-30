# AuditLedger Subgraph

The AuditLedger subgraph indexes every on-chain event emitted by the Soroban AuditLedger contract and exposes them through a decentralized GraphQL API. This gives the UI and external consumers historical and analytical queries without hitting the contract directly.

## Overview

- **Network:** Stellar Soroban (Testnet / Mainnet)
- **Data source:** Firehose / Substrate-based indexer for Stellar Soroban events
- **Schema version:** 0.0.4
- **Contract:** AuditLedger (Soroban WASM)

## Events Indexed

| Event | Handler | Description |
| --- | --- | --- |
| `EventLogged` | `handleEventLogged` | New event appended to the chain |
| `EventUpdated` | `handleEventUpdated` | Existing event metadata updated |
| `EventRolledBack` | `handleEventRolledBack` | Event reverted via compensating entry |
| `GovernanceAction` | `handleGovernanceAction` | Ownership/cap/pause changes |
| `SnapshotTaken` | `handleSnapshotTaken` | Point-in-time state commitment |
| `ArchivedEvent` | `handleArchivedEvent` | Event moved to cold storage |

## Entities

### `Event`

Primary record for every event. Fields: `id`, `index`, `eventType`, `submitter`, `metadata`, `eventHash`, `prevHash`, `timestamp`, `kind`, `createdAt`.

### `EventCount`

Global counters broken down by kind: `total`, `logged`, `updated`, `rolledBack`.

### `SubmitterStats`

Per-address aggregates: `totalEvents`, `eventsByType`, `firstSeen`, `lastSeen`.

### `TypeStats`

Per-event-type aggregates: `count`, `lastSeen`.

### `GovernanceEvent`

Historical governance actions with `action`, `caller`, `oldValue`, `newValue`, `approvedBy`, `requiredApprovals`, `timestamp`, `status`.

### `Snapshot`

Point-in-time snapshots with `eventCount`, `hash`, `timestamp`.

### `ArchiveRecord`

Archived events with `index`, `archiveHash`, `timestamp`.

### `ContractStats`

Singleton global stats: `totalEvents`, `totalUpdates`, `totalRollbacks`, `totalGovernance`, `totalSnapshots`, `totalArchived`, `lastUpdated`.

## Example Queries

### Latest events

```graphql
query LatestEvents {
  events(first: 10, orderBy: index, orderDirection: desc) {
    id
    index
    eventType
    submitter
    timestamp
    eventHash
    prevHash
  }
}
```

### Events by type
```graphql
{
  events(where: { eventType: "payment" }, first: 50) {
    index
    submitter
    metadata
  }
}
```

### Submitter activity
```graphql
{
  submitterStats(id: "GABC1234") {
    totalEvents
    eventsByType
    firstSeen
    lastSeen
  }
}
```

### Governance history
```graphql
{
  governanceEvents(first: 20, orderBy: timestamp, orderDirection: desc) {
    action
    caller
    oldValue
    newValue
    timestamp
  }
}
```

### Global stats

```graphql
{
  contractStats(id: "global") {
    totalEvents
    totalUpdates
    totalRollbacks
    totalGovernance
    totalSnapshots
    totalArchived
  }
}
```

## Local Development

1. Install dependencies: `npm install`
2. Generate types: `npm run codegen`
3. Start a local Graph node + IPC (docker-compose in `repo/docker`)
4. Create the subgraph: `npm run create:local`
5. Deploy: `npm run deploy:local`
6. Query at `http://localhost:8000/subgraphs/name/audit-ledger`

## Deployment

### Graph Hosted Service

```bash
graph auth <ACCESS_TOKEN>
graph deploy \
  --subgraph audit-ledger \
  --node https://api.thegraph.com/ \
  --ip-fs https://api.thegraph.com/ipfs \
  --access-token <DEPLOY_KEY>
```

### Decentralized Network

```bash
graph deploy \
  --subgraph audit-ledger \
  --node https://gateway.thegraph.com/deploy \
  --ip-fs https://api.thegraph.com/ipfs \
  --network stellar \
  --access-token <DEPLOY_KEY>
```

## Testing

Unit tests use Matchstick to run handlers against mock events. Run with:

```bash
npm test
```

The CI workflow at `.github/workflows/subgraph.yml` builds and tests the subgraph on every push and PR.

## UI Integration

The frontend queries the subgraph via configurable endpoint `SUBGRAPH_URL`. Historical views (event timeline, submitter dashboard, governance log) fetch from the subgraph and fall back to the on-chain GraphQL API in `api/graphql/` when the subgraph is unavailable.
