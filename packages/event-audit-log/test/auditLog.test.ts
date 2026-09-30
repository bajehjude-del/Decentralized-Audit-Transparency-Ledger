import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIT_ACTIONS,
  AuditLog,
  DEFAULT_RETENTION_POLICY,
  GENESIS_HASH,
  SiemSink,
  canonicalize,
  controlsFor,
  digest,
  entryHash,
  formatEntries,
  httpTransport,
  memoryTransport,
  planPurge,
  planTierTransitions,
  reportToCsv,
  reportToJson,
  retentionDeadline,
  stdoutTransport,
  summarize,
  tierCounts,
  tierForAge,
  toCef,
  toCsv,
  toEcs,
  toSummaryLine,
  toSyslog5424,
  verdict,
} from "../src/index.ts";
import type { AuditEntry, AuditInput, AuditLogOptions, RetentionPolicy } from "../src/index.ts";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function input(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    action: AUDIT_ACTIONS.EVENT_EMIT,
    outcome: "success",
    actor: { id: "svc-relayer", type: "service", ip: "10.0.0.4" },
    resource: { id: "evt-1", type: "contract_event", contractId: "CTR_A" },
    contractId: "CTR_A",
    eventId: "evt-1",
    ...overrides,
  };
}

function logAt(timestamp: number, options: AuditLogOptions = {}): AuditLog {
  let current = timestamp;
  return new AuditLog({
    now: () => {
      current = timestamp;
      return current;
    },
    ...options,
  });
}

function entriesOf(log: AuditLog): AuditEntry[] {
  return log.entries();
}

test("canonicalize is key-order independent and drops undefined", () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalize({ a: 2, b: 1 }), canonicalize({ b: 1, a: 2 }));
  assert.equal(canonicalize({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalize([1, { z: 1, a: 2 }]), '[1,{"a":2,"z":1}]');
  assert.equal(canonicalize(null), "null");
  assert.equal(canonicalize(Number.NaN), "null");
});

test("digest is prefixed and stable", () => {
  const first = digest("payload");
  assert.equal(first, digest("payload"));
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(first, digest("payload-2"));
});

test("record assigns sequence, links, and default severity", () => {
  const log = logAt(NOW);
  const entry = log.record(input());

  assert.equal(entry.sequence, 1);
  assert.equal(entry.prevHash, GENESIS_HASH);
  assert.equal(entry.tier, "hot");
  assert.equal(entry.sealed, false);
  assert.equal(entry.severity, "info");
  assert.equal(entry.timestampIso, new Date(NOW).toISOString());
  assert.equal(entry.contractId, "CTR_A", "contractId falls back to the resource");
});

test("severity defaults follow the outcome and can be overridden", () => {
  const log = logAt(NOW);
  assert.equal(log.record(input({ outcome: "failure" })).severity, "medium");
  assert.equal(log.record(input({ outcome: "denied" })).severity, "high");
  assert.equal(
    log.record(input({ outcome: "denied", severity: "critical" })).severity,
    "critical"
  );
});

test("record rejects incomplete operations", () => {
  const log = logAt(NOW);
  assert.throws(() => log.record(input({ action: "" })), /action is required/);
  assert.throws(() => log.record(input({ actor: { id: "" } })), /actor id is required/);
  assert.throws(() => log.record(input({ resource: { id: "", type: "x" } })), /resource id is required/);
});

test("the chain links entries and verifies clean", () => {
  const log = logAt(NOW);
  log.recordAll([input(), input({ eventId: "evt-2" }), input({ eventId: "evt-3" })]);
  const entries = entriesOf(log);

  assert.equal(entries[1].prevHash, entries[0].hash);
  assert.equal(entries[2].prevHash, entries[1].hash);
  assert.equal(log.head, entries[2].hash);

  const report = log.verify();
  assert.equal(report.valid, true);
  assert.equal(report.entries, 3);
  assert.equal(report.recomputed, 3);
  assert.equal(report.headHash, entries[2].hash);
  assert.deepEqual(report.issues, []);
});

test("entryHash matches the hash stored on append", () => {
  const log = logAt(NOW);
  const first = log.record(input());
  const second = log.record(input({ eventId: "evt-2" }));
  assert.equal(second.hash, entryHash(second, first.hash));
});

test("a seeded genesis hash anchors a resumed chain", () => {
  const anchor = digest("previous-run");
  const log = logAt(NOW, { genesisHash: anchor });
  const entry = log.record(input());
  assert.equal(entry.prevHash, anchor);
  assert.equal(log.verify().valid, true);
});

test("editing a record breaks the hash chain", () => {
  const log = logAt(NOW);
  log.recordAll([input(), input({ eventId: "evt-2" })]);
  const entries = entriesOf(log);

  (entries[0] as { outcome: string }).outcome = "denied";

  const report = log.verify();
  assert.equal(report.valid, false);
  assert.equal(report.issues.length, 1);
  assert.equal(report.issues[0].sequence, 1);
  assert.equal(report.issues[0].kind, "hash-mismatch");
  assert.match(report.issues[0].message, /recomputed sha256:/);
  assert.equal(report.recomputed, 1, "the untouched second entry still verifies");
});

test("a rewrite that recomputes every hash is caught by a published head anchor", () => {
  const log = logAt(NOW);
  log.recordAll([input(), input({ eventId: "evt-2" })]);
  // What an auditor would publish to an append-only register.
  const publishedHead = log.head;

  // A sophisticated tamper: rewrite the record, then recompute the whole chain.
  const entries = entriesOf(log);
  (entries[0] as { outcome: string }).outcome = "denied";
  entries[0].hash = entryHash(entries[0], entries[0].prevHash);
  entries[1].prevHash = entries[0].hash;
  entries[1].hash = entryHash(entries[1], entries[0].hash);

  assert.equal(log.verify().valid, true, "the chain is internally consistent again");
  const anchored = log.verify({ expectedHead: publishedHead });
  assert.equal(anchored.valid, false);
  assert.equal(anchored.issues[0].kind, "head-anchor-mismatch");
  assert.equal(log.verify({ expectedHead: log.head }).valid, true);
});

test("deleting an entry leaves a sequence gap", () => {
  const log = logAt(NOW);
  log.recordAll([input(), input({ eventId: "evt-2" }), input({ eventId: "evt-3" })]);
  const entries = entriesOf(log);
  entries.splice(1, 1);

  const report = log.verify();
  const kinds = report.issues.map((issue) => issue.kind);
  assert.equal(report.valid, false);
  assert.equal(kinds.includes("sequence-gap"), true);
  assert.equal(kinds.includes("broken-chain"), true);
});

test("a backdated entry is reported as a timestamp regression", () => {
  const log = logAt(NOW);
  log.recordAll([
    input({ timestamp: NOW - DAY }),
    input({ timestamp: NOW - 10 * DAY, eventId: "evt-2" }),
  ]);

  const report = log.verify();
  assert.equal(report.valid, false);
  assert.equal(report.issues.some((issue) => issue.kind === "timestamp-regression"), true);
});

test("query filters compose with AND and honours the limit", () => {
  const log = logAt(NOW);
  log.recordAll([
    input({ eventId: "evt-1" }),
    input({ eventId: "evt-2", outcome: "failure" }),
    input({ eventId: "evt-3", action: AUDIT_ACTIONS.CONTRACT_UPGRADE, actor: { id: "admin" } }),
  ]);

  assert.equal(log.query({ outcome: "failure" }).length, 1);
  assert.equal(log.query({ action: AUDIT_ACTIONS.CONTRACT_UPGRADE }).length, 1);
  assert.equal(log.query({ actorId: "admin" }).length, 1);
  assert.equal(log.query({ contractId: "CTR_A" }).length, 3);
  assert.equal(log.query({ contractId: "CTR_MISSING" }).length, 0);
  assert.equal(log.query({ from: NOW + 1 }).length, 0);
  assert.equal(log.query({ to: NOW - 1 }).length, 0);
  assert.equal(log.query({ limit: 2 }).length, 2);
  assert.equal(log.query({ outcome: "failure", action: AUDIT_ACTIONS.CONTRACT_UPGRADE }).length, 0);
});

test("tail returns the newest entries first", () => {
  const log = logAt(NOW);
  log.recordAll([input({ eventId: "a" }), input({ eventId: "b" }), input({ eventId: "c" })]);
  assert.deepEqual(
    log.tail(2).map((entry) => entry.eventId),
    ["c", "b"]
  );
});

test("every structured format encodes the chain link", () => {
  const log = logAt(NOW);
  const entry = log.record(input({ outcomeReason: "emitted to ledger" }));
  const batch = [entry];

  const json = formatEntries(batch, "json");
  assert.match(json, new RegExp(entry.hash));
  assert.equal(JSON.parse(json).length, 1);

  const ndjson = formatEntries(batch, "ndjson");
  assert.equal(ndjson.split("\n").length, 1);
  assert.equal(JSON.parse(ndjson).hash, entry.hash);

  const csv = formatEntries(batch, "csv");
  const [header, row] = csv.split("\n");
  assert.match(header, /prevHash,hash$/);
  assert.match(row, new RegExp(`${entry.prevHash},${entry.hash}$`));
});

test("csv quotes cells that contain separators", () => {
  const log = logAt(NOW);
  const entry = log.record(input({ outcomeReason: 'comma, and "quotes"' }));
  const row = toCsv([entry]).split("\n")[1];
  assert.match(row, /"comma, and ""quotes"""/);
});

test("syslog 5424 output carries severity, structured data, and hashes", () => {
  const log = logAt(NOW);
  const entry = log.record(input({ outcome: "denied", severity: "critical" }));

  const line = toSyslog5424(entry);
  assert.match(line, /^<2>1 /);
  assert.match(line, /2023-11-14T22:13:20\.000Z/);
  assert.match(line, /10\.0\.0\.4/);
  assert.match(line, /sequence="1"/);
  assert.match(line, new RegExp(`hash="${entry.hash}"`));
  assert.match(line, new RegExp(`prevHash="${entry.prevHash}"`));
});

test("cef output carries the CEF header and extension pairs", () => {
  const log = logAt(NOW);
  const entry = log.record(input({ outcome: "failure", severity: "high" }));

  const line = toCef(entry);
  assert.match(line, /^CEF:0\|AuditLedger\|ContractEventAuditLog\|1\.0\|8\|event\.emit\|/);
  assert.match(line, new RegExp(`cs2=${entry.hash}`));
  assert.match(line, /suser=svc-relayer/);
  assert.match(line, /cs1Label=ContractId cs1=CTR_A/);
});

test("cef and syslog escape structural characters", () => {
  const log = logAt(NOW);
  const entry = log.record(input({ actor: { id: 'ev"il' } }));
  assert.match(toSyslog5424(entry), /actor="ev\\"il"/);
  assert.equal(toCef(entry).includes("|"), true, "CEF header keeps its own pipes");
});

test("ecs output maps onto Elastic Common Schema", () => {
  const log = logAt(NOW);
  const entry = log.record(input({ tags: ["pii"] }));
  const ecs = toEcs(entry) as Record<string, any>;

  assert.equal(ecs["@timestamp"], new Date(NOW).toISOString());
  assert.equal(ecs.event.action, "event.emit");
  assert.equal(ecs.event.outcome, "success");
  assert.equal(ecs.user.id, "svc-relayer");
  assert.equal(ecs.ledger.hash, entry.hash);
  assert.equal(ecs.ledger.prev_hash, entry.prevHash);
  assert.deepEqual(ecs.labels, ["pii"]);
});

test("export renders a filtered window in the requested format", () => {
  const log = logAt(NOW);
  log.recordAll([input({ eventId: "a" }), input({ eventId: "b", outcome: "denied" })]);
  const csv = log.export({ outcome: "denied" }, "csv");
  assert.equal(csv.split("\n").length, 2);
  assert.match(csv, /denied/);
  assert.equal(log.export({}, "ndjson").split("\n").length, 2);
});

test("tierForAge walks hot to archive", () => {
  const policy = DEFAULT_RETENTION_POLICY;
  assert.equal(tierForAge(policy, 0).tier, "hot");
  assert.equal(tierForAge(policy, 8 * DAY).tier, "warm");
  assert.equal(tierForAge(policy, 120 * DAY).tier, "cold");
  assert.equal(tierForAge(policy, 400 * DAY).tier, "archive");
  assert.equal(tierForAge(policy, 0).immutable, false);
  assert.equal(tierForAge(policy, 120 * DAY).immutable, true);
});

test("retention transitions are planned once and applied without breaking the chain", () => {
  const policy: RetentionPolicy = {
    ...DEFAULT_RETENTION_POLICY,
    rules: [
      { tier: "hot", afterMs: 0, immutable: false, description: "hot" },
      { tier: "archive", afterMs: 30 * DAY, immutable: true, description: "archive" },
    ],
  };
  const log = logAt(NOW, { retention: policy });
  log.recordAll([input({ eventId: "old", timestamp: NOW - 60 * DAY }), input({ eventId: "new" })]);

  const transitions = log.applyRetention(NOW);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].sequence, 1);
  assert.equal(transitions[0].to, "archive");
  assert.equal(transitions[0].sealed, true);

  const entries = entriesOf(log);
  assert.equal(entries[0].tier, "archive");
  assert.equal(entries[0].sealed, true);
  assert.equal(entries[1].tier, "hot");
  assert.equal(entries[1].sealed, false);
  assert.equal(log.applyRetention(NOW).length, 0, "transitions are applied once");
  assert.equal(log.verify().valid, true, "tier changes are outside the hashed body");
});

test("planTierTransitions reports the target tier without mutating", () => {
  const log = logAt(NOW);
  log.record(input({ timestamp: NOW - 400 * DAY }));
  const transitions = planTierTransitions(entriesOf(log), DEFAULT_RETENTION_POLICY, NOW);
  assert.equal(transitions[0].from, "hot");
  assert.equal(transitions[0].to, "archive");
  assert.equal(entriesOf(log)[0].tier, "hot");
});

test("retention deadline follows the oldest entry", () => {
  const log = logAt(NOW);
  log.recordAll([input({ eventId: "a", timestamp: NOW - 100 * DAY }), input({ eventId: "b" })]);
  assert.equal(log.retentionDeadline(), NOW - 100 * DAY + DEFAULT_RETENTION_POLICY.minRetentionMs);
  assert.equal(retentionDeadline([], DEFAULT_RETENTION_POLICY), null);
});

test("a write-once policy blocks purging sealed entries", () => {
  const policy: RetentionPolicy = {
    ...DEFAULT_RETENTION_POLICY,
    rules: [
      { tier: "hot", afterMs: 0, immutable: false, description: "hot" },
      { tier: "archive", afterMs: DAY, immutable: true, description: "archive" },
    ],
    minRetentionMs: DAY,
  };
  const log = logAt(NOW, { retention: policy });
  log.recordAll([
    input({ eventId: "hot", timestamp: NOW - 2 * DAY }),
    input({ eventId: "archived", timestamp: NOW - 2 * DAY }),
  ]);
  log.applyRetention(NOW);

  const plan = planPurge(entriesOf(log), NOW, policy);
  const reasons = new Map(plan.decisions.map((decision) => [decision.sequence, decision.reason]));
  assert.equal(reasons.get(1), "write-once");
  assert.equal(reasons.get(2), "write-once");
  assert.deepEqual(plan.purgeableIds, []);
});

test("a non-write-once policy can purge unsealed entries past the deadline", () => {
  const policy: RetentionPolicy = {
    ...DEFAULT_RETENTION_POLICY,
    rules: [
      { tier: "hot", afterMs: 0, immutable: false, description: "hot" },
      { tier: "archive", afterMs: 10 * DAY, immutable: false, description: "archive" },
    ],
    minRetentionMs: 5 * DAY,
    writeOnce: false,
  };
  const log = logAt(NOW, { retention: policy });
  log.recordAll([
    input({ eventId: "old", timestamp: NOW - 30 * DAY }),
    input({ eventId: "recent", timestamp: NOW - 1 * DAY }),
  ]);

  const plan = planPurge(entriesOf(log), NOW, policy);
  const reasons = plan.decisions.map((decision) => decision.reason);
  assert.equal(reasons[0], "eligible");
  assert.equal(reasons[1], "min-retention");
  assert.equal(plan.purgeableIds.length, 1);
  assert.equal(plan.deadline, NOW - 30 * DAY + 5 * DAY);
});

test("sealed entries refuse modification under a write-once policy", () => {
  const log = logAt(NOW);
  const entry = log.record(input());
  log.assertEditable(entry);
  entry.sealed = true;
  assert.throws(() => log.assertEditable(entry), /sealed in the hot tier/);
});

test("tierCounts summarises the log", () => {
  const log = logAt(NOW);
  log.recordAll([input({ eventId: "a" }), input({ eventId: "b" })]);
  assert.deepEqual(tierCounts(entriesOf(log)), { hot: 2, warm: 0, cold: 0, archive: 0 });
  assert.equal(log.stats().total, 2);
  assert.equal(log.stats().valid, true);
});

test("siem sink batches entries and reports delivery", async () => {
  const log = logAt(NOW);
  log.recordAll([input({ eventId: "a" }), input({ eventId: "b" }), input({ eventId: "c" })]);
  const transport = memoryTransport();
  const sink = new SiemSink({ transport, format: "cef", batchSize: 2 });

  const partial = await sink.enqueueAll(entriesOf(log));
  assert.equal(partial?.accepted, 2, "a full batch flushes immediately");
  assert.equal(sink.pending(), 1);
  assert.equal(transport.batches.length, 1);

  const flushed = await sink.flush();
  assert.equal(flushed.accepted, 1);
  assert.equal(flushed.batches, 2);
  assert.equal(transport.batches.length, 2);
  assert.equal(sink.pending(), 0);
  assert.match(transport.batches[0][0], /^CEF:0\|/);
});

test("siem sink retries with backoff and then gives up", async () => {
  const log = logAt(NOW);
  log.record(input());
  const transport = memoryTransport();
  transport.setFailure("collector unreachable");
  const waits: number[] = [];
  const sink = new SiemSink({
    transport,
    maxAttempts: 3,
    initialBackoffMs: 10,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });

  await sink.enqueue(log.entries()[0]);
  const result = await sink.flush();

  assert.equal(result.accepted, 0);
  assert.equal(result.attempts, 3);
  assert.equal(result.errors.length, 3);
  assert.deepEqual(waits, [10, 20]);
  assert.equal(sink.droppedCount(), 1);
  assert.equal(sink.history()[0].attempts, 3);
});

test("siem sink recovers when the transport starts working again", async () => {
  const log = logAt(NOW);
  log.record(input());
  const transport = memoryTransport();
  transport.setFailure("collector unreachable");
  const sink = new SiemSink({ transport, maxAttempts: 2, sleep: async () => undefined });

  const failed = await sink.enqueue(log.entries()[0]).then((value) => value ?? sink.flush());
  assert.equal(failed?.accepted, 0);

  transport.setFailure(null);
  log.record(input({ eventId: "evt-2" }));
  const recovered = await sink.enqueue(log.entries()[1]).then((value) => value ?? sink.flush());
  assert.equal(recovered?.accepted, 1);
  assert.equal(transport.batches.length, 1);
});

test("flushing an empty sink is a no-op", async () => {
  const sink = new SiemSink({ transport: memoryTransport() });
  const result = await sink.flush();
  assert.deepEqual(result, { accepted: 0, attempts: 0, errors: [], batches: 0, flushedAt: result.flushedAt });
});

test("http transport posts the batch and surfaces http failures", async () => {
  const seen: Array<{ url: string; body: string }> = [];
  const transport = httpTransport({
    url: "https://siem.example/ingest",
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), body: String(init?.body) });
      return { ok: true, status: 202 } as Response;
    },
  });
  const ok = await transport.send(["line-1", "line-2"]);
  assert.equal(ok.accepted, 2);
  assert.match(seen[0].body, /line-1/);

  const failing = httpTransport({
    url: "https://siem.example/ingest",
    fetchImpl: async () => ({ ok: false, status: 503 }) as Response,
  });
  await assert.rejects(() => failing.send(["line"]), /HTTP 503/);
});

test("stdout transport collects shipped lines", async () => {
  const log = logAt(NOW);
  log.record(input());
  const transport = stdoutTransport();
  const sink = new SiemSink({ transport, format: "syslog5424" });
  await log.ship(sink);
  await sink.flush();
  assert.equal(transport.lines.length, 1);
  assert.match(transport.lines[0], /^<\d+>1 /);
});

test("ship does not remove entries from the log", async () => {
  const log = logAt(NOW);
  log.record(input());
  const sink = new SiemSink({ transport: memoryTransport() });
  await log.ship(sink);
  await sink.flush();
  assert.equal(log.length, 1);
});

test("controlsFor returns the catalogue and can narrow it", () => {
  const all = controlsFor("SOC2");
  assert.equal(all.length > 0, true);
  assert.equal(all.every((control) => control.framework === "SOC2"), true);
  assert.deepEqual(
    controlsFor("SOC2", ["CC7.2"]).map((control) => control.control),
    ["CC7.2"]
  );
  assert.deepEqual(controlsFor("SOC2", ["NOPE"]), []);
  assert.equal(controlsFor("GDPR").every((control) => control.framework === "GDPR"), true);
});

test("report aggregates the window and maps controls to integrity evidence", () => {
  const log = logAt(NOW);
  log.recordAll([
    input({ actor: { id: "alice" } }),
    input({ actor: { id: "alice" }, outcome: "failure" }),
    input({ actor: { id: "bob" }, outcome: "denied", action: AUDIT_ACTIONS.ACCESS_REVOKE }),
  ]);

  const report = log.report("SOC2", { from: NOW - DAY, to: NOW + DAY }, controlsFor("SOC2"));

  assert.equal(report.framework, "SOC2");
  assert.equal(report.totalRecords, 3);
  assert.deepEqual(report.byOutcome, { success: 1, failure: 1, denied: 1 });
  assert.equal(report.byAction["event.emit"], 2);
  assert.equal(report.byAction["access.revoke"], 1);
  assert.equal(report.topActors[0].actorId, "alice");
  assert.equal(report.topActors[0].records, 2);
  assert.equal(report.topActors[0].failures, 1);
  assert.equal(report.integrity.valid, true);
  assert.equal(report.controls.every((control) => control.satisfied), true);
  assert.match(report.controls[0].evidence, /hash chain verified across 3 entries/);

  const result = verdict(report);
  assert.equal(result.passed, true);
  assert.equal(result.unsatisfied, 0);
  assert.match(toSummaryLine(report), /^SOC2: 5\/5 controls satisfied/);
});

test("a broken chain fails the compliance verdict", () => {
  const log = logAt(NOW);
  log.recordAll([input(), input()]);
  (entriesOf(log)[0] as { action: string }).action = "contract.destroy";

  const report = log.report("GDPR", { from: 0, to: NOW }, controlsFor("GDPR"));
  assert.equal(report.integrity.valid, false);
  assert.equal(report.controls.every((control) => !control.satisfied), true);
  assert.match(report.controls[0].evidence, /integrity check failed/);
  assert.equal(verdict(report).passed, false);
  assert.match(toSummaryLine(report), /integrity FAILED/);
});

test("summarize describes the evidence set", () => {
  const log = logAt(NOW);
  log.recordAll([
    input({ timestamp: NOW - 2 * DAY }),
    input({ timestamp: NOW, outcome: "denied", actor: { id: "bob" } }),
  ]);
  const summary = summarize(entriesOf(log), log.verify());

  assert.equal(summary.entries, 2);
  assert.equal(summary.firstEntryAt, NOW - 2 * DAY);
  assert.equal(summary.lastEntryAt, NOW);
  assert.equal(summary.coverageMs, 2 * DAY);
  assert.deepEqual(summary.actionsCovered, ["event.emit"]);
  assert.equal(summary.distinctActors, 2);
  assert.equal(summary.deniedOperations, 1);
  assert.equal(summary.integrity.valid, true);
});

test("reports render as json and csv", () => {
  const log = logAt(NOW);
  log.record(input());
  const report = log.report("ISO27001", { from: 0, to: NOW }, controlsFor("ISO27001"));

  assert.equal(JSON.parse(reportToJson(report)).framework, "ISO27001");
  const csv = reportToCsv(report);
  assert.match(csv.split("\n")[0], /framework,control,title,satisfied,evidence/);
  assert.equal(csv.split("\n").length, 5);
});
