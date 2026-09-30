# @audit-ledger/event-audit-log

Tamper-evident audit logging for contract events. Every contract operation is
appended to a hash chain, encoded in archive or SIEM formats, aged through
retention tiers, and mapped onto compliance controls.

Zero runtime dependencies. Requires Node.js 22.6 or newer.

## Usage

```ts
import { AuditLog, SiemSink, controlsFor, httpTransport } from "@audit-ledger/event-audit-log";

const log = new AuditLog();

log.record({
  action: "contract.upgrade",
  outcome: "success",
  actor: { id: "admin:did:stellar:alice", type: "user", ip: "10.0.0.4" },
  resource: { id: "CTR_A", type: "contract", contractId: "CTR_A" },
  contractId: "CTR_A",
  eventId: "evt-991",
  detail: { from: "v3", to: "v4" },
});

// Compliance evidence.
const report = log.verify();
if (!report.valid) console.error(report.issues);

// Framework mapped reporting.
const soc2 = log.report("SOC2", { from: Date.now() - 86_400e3, to: Date.now() }, controlsFor("SOC2"));

// Ship to a SIEM in CEF.
const sink = new SiemSink({
  transport: httpTransport({ url: "https://siem.example/ingest" }),
  format: "cef",
  batchSize: 100,
});
await log.ship(sink);
await sink.flush();
```

## Tamper evidence

Each entry commits to its predecessor:

```
hash(n) = sha256( hash(n-1) || canonicalJson(record(n)) )
```

`canonicalize` sorts object keys and drops `undefined`, so equal records always
hash identically regardless of field order. Chain metadata (`hash`, `prevHash`,
`tier`, `sealed`) sits outside the hashed body, so promoting an entry between
retention tiers never invalidates the chain.

`verify()` recomputes every hash and reports:

| Issue | Meaning |
| --- | --- |
| `hash-mismatch` | The entry's stored hash does not match its content |
| `broken-chain` | The entry links to a hash the previous entry does not have |
| `sequence-gap` | An entry was removed from the middle of the log |
| `timestamp-regression` | An entry was backdated relative to its predecessor |
| `entry-tampered` | A hash mismatch at a sequence that is also out of order |
| `head-anchor-mismatch` | The head differs from an externally published head |

A hash chain alone cannot detect a rewrite that recomputes every hash. Publish
the head somewhere append-only and pass it back to close that gap:

```ts
const publishedHead = log.head;             // publish to a transparency log
log.verify({ expectedHead: publishedHead }); // detects a full rewrite
```

`genesisHash` does the same for a log continued across process restarts.

## Formats

`formatEntries(entries, format)` and `log.export(filter, format)` support:

| Format | Use |
| --- | --- |
| `json` | Human review, evidence bundles |
| `ndjson` | Streamed to object storage, read by log shippers |
| `csv` | Spreadsheet and filing-system exports |
| `syslog5424` | RFC 5424 syslog with the chain in structured data |
| `cef` | ArcSight CEF, the most widely ingested SIEM dialect |
| `ecs` | Elastic Common Schema 8.11 |

Structural characters are escaped in syslog parameters and CSV cells.

## SIEM delivery

`SiemSink` buffers entries, encodes each in the configured dialect, and ships
them in batches. Delivery never throws: failures are counted in the returned
`FlushResult` (`accepted`, `attempts`, `errors`) and the retry history is
available from `history()`. Transient failures retry with exponential backoff up
to `maxAttempts`; entries that exhaust their attempts count towards
`droppedCount()`. Transports: `httpTransport`, `memoryTransport`,
`stdoutTransport`, or your own `SiemTransport`.

## Long-term retention

Entries age through `hot` → `warm` → `cold` → `archive` per
`DEFAULT_RETENTION_POLICY`. `applyRetention(now)` promotes entries whose tier no
longer matches their age and seals the immutable ones. `planPurge(now)` returns
per-entry decisions, and a `writeOnce` policy refuses to purge anything sealed —
the WORM guarantee. `retentionDeadline()` reports the earliest instant any entry
may legally be destroyed.

## Compliance reporting

`log.report(framework, period, controls)` returns activity counts (by action,
outcome, severity, tier), the top actors with their failure and denial counts,
the integrity report, and each control with satisfied status and evidence.
`verdict(report)` rolls the controls into a pass/fail, and `toSummaryLine`
renders one line for a CI job or a ticket. Frameworks: SOC2, ISO27001, GDPR, SOX,
MiCA.

## Tests

```sh
npm test
```

## Issue

Implements [#428](https://github.com/daddygokings-art/Decentralized-Audit-Transparency-Ledger/issues/428)
— contract event audit logging for compliance.
