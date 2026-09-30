import { BigDecimal, BigInt, Address, bytes } from "@graphprotocol/graph-ts/common";
import { EventLogged, EventUpdated, EventRolledBack, GovernanceAction, SnapshotTaken, ArchivedEvent } from "../generated/AuditLedger/AuditLedger";
import { Event, EventCount, SubmitterStats, TypeStats, GovernanceEvent, Snapshot, ArchiveRecord, ContractStats } from "../generated/schema";

function eventId(index: BigInt): string {
  return index.toString();
}

function getOrCreateContractStats(): ContractStats {
  let stats = ContractStats.load("global");
  if (stats == null) {
    stats = new ContractStats("global");
    stats.totalEvents = BigInt.fromI8(0);
    stats.totalUpdates = BigInt.fromI8(0);
    stats.totalRollbacks = BigInt.fromI8(0);
    stats.totalGovernance = BigInt.fromI8(0);
    stats.totalSnapshots = BigInt.fromI8(0);
    stats.totalArchived = BigInt.fromI8(0);
    stats.lastUpdated = BigInt.fromI8(0);
    stats.save();
  }
  return stats!;
}

function getOrCreateEventCount(): EventCount {
  let count = EventCount.load("global");
  if (count == null) {
    count = new EventCount("global");
    count.total = BigInt.fromI8(0);
    count.logged = BigInt.fromI8(0);
    count.updated = BigInt.fromI8(0);
    count.rolledBack = BigInt.fromI8(0);
    count.save();
  }
  return count!;
}

function getOrCreateSubmitter(submitter: string): SubmitterStats {
  let stats = SubmitterStats.load(submitter);
  if (stats == null) {
    stats = new SubmitterStats(submitter);
    stats.address = Address.fromString(submitter);
    stats.totalEvents = BigInt.fromI8(0);
    stats.eventsByType = [];
    stats.firstSeen = BigInt.fromI8(0);
    stats.lastSeen = BigInt.fromI8(0);
    stats.save();
  }
  return stats!;
}

function getOrCreateTypeStats(eventType: string): TypeStats {
  let stats = TypeStats.load(eventType);
  if (stats == null) {
    stats = new TypeStats(eventType);
    stats.eventType = eventType;
    stats.count = BigInt.fromI8(0);
    stats.lastSeen = BigInt.fromI8(0);
    stats.save();
  }
  return stats!;
}

function recordEvent(
  index: BigInt,
  eventType: string,
  submitter: string,
  metadata: string,
  eventHash: string,
  prevHash: string,
  timestamp: BigInt,
  kind: string,
): Event {
  const id = eventId(index);
  let event = Event.load(id);
  if (event == null) {
    event = new Event(id);
    event.index = index;
    event.createdAt = timestamp;
  }
  event.eventType = eventType;
  event.submitter = Address.fromString(submitter);
  event.metadata = metadata;
  event.eventHash = eventHash;
  event.prevHash = prevHash;
  event.timestamp = timestamp;
  event.kind = kind;
  event.save();
  return event as Event;
}

function updateAggregates(eventType: string, submitter: string, timestamp: BigInt): void {
  const count = getOrCreateEventCount();
  count.total = count.total.plus(BigInt.fromI8(1));
  count.save();

  const submitterStats = getOrCreateSubmitter(submitter);
  submitterStats.totalEvents = submitterStats.totalEvents.plus(BigInt.fromI8(1));
  if (submitterStats.firstSeen.equals(BigInt.fromI8(0))) {
    submitterStats.firstSeen = timestamp;
  }
  submitterStats.lastSeen = timestamp;
  const existing = submitterStats.eventsByType;
  let found = false;
  for (let i = 0; i < existing.length; i++) {
    if (existing[i] === eventType) {
      found = true;
      break;
    }
  }
  if (!found) {
    existing.push(eventType);
    submitterStats.eventsByType = existing;
  }
  submitterStats.save();

  const typeStats = getOrCreateTypeStats(eventType);
  typeStats.count = typeStats.count.plus(BigInt.fromI8(1));
  typeStats.lastSeen = timestamp;
  typeStats.save();

  const contractStats = getOrCreateContractStats();
  contractStats.lastUpdated = timestamp;
  contractStats.save();
}

export function handleEventLogged(event: EventLogged): void {
  const index = event.params.index;
  const eventType = event.params.eventType;
  const submitter = event.params.submitter;
  const metadata = event.params.metadata;
  const eventHash = event.params.eventHash;
  const prevHash = event.params.prevHash;
  const timestamp = event.params.timestamp;

  recordEvent(index, eventType, submitter, metadata, eventHash, prevHash, timestamp, "logged");

  const count = getOrCreateEventCount();
  count.logged = count.logged.plus(BigInt.fromI8(1));
  count.save();

  const contractStats = getOrCreateContractStats();
  contractStats.totalEvents = contractStats.totalEvents.plus(BigInt.fromI8(1));
  contractStats.save();

  updateAggregates(eventType, submitter, timestamp);
}

export function handleEventUpdated(event: EventUpdated): void {
  const index = event.params.index;
  const eventType = event.params.eventType;
  const submitter = event.params.submitter;
  const metadata = event.params.metadata;
  const eventHash = event.params.eventHash;
  const prevHash = event.params.prevHash;
  const timestamp = event.params.timestamp;

  recordEvent(index, eventType, submitter, metadata, eventHash, prevHash, timestamp, "updated");

  const count = getOrCreateEventCount();
  count.updated = count.updated.plus(BigInt.fromI8(1));
  count.save();

  const contractStats = getOrCreateContractStats();
  contractStats.totalUpdates = contractStats.totalUpdates.plus(BigInt.fromI8(1));
  contractStats.save();

  updateAggregates(eventType, submitter, timestamp);
}

export function handleEventRolledBack(event: EventRolledBack): void {
  const index = event.params.index;
  const eventType = event.params.eventType;
  const submitter = event.params.submitter;
  const metadata = event.params.metadata;
  const eventHash = event.params.eventHash;
  const prevHash = event.params.prevHash;
  const timestamp = event.params.timestamp;

  recordEvent(index, eventType, submitter, metadata, eventHash, prevHash, timestamp, "rolled_back");

  const count = getOrCreateEventCount();
  count.rolledBack = count.rolledBack.plus(BigInt.fromI8(1));
  count.save();

  const contractStats = getOrCreateContractStats();
  contractStats.totalRollbacks = contractStats.totalRollbacks.plus(BigInt.fromI8(1));
  contractStats.save();

  updateAggregates(eventType, submitter, timestamp);
}

export function handleGovernanceAction(event: GovernanceAction): void {
  const id = event.transaction.hash + "-" + event.logIndex.toString();
  const gov = new GovernanceEvent(id);
  gov.action = event.params.action;
  gov.caller = Address.fromString(event.params.caller);
  gov.oldValue = event.params.oldValue;
  gov.newValue = event.params.newValue;
  gov.approvedBy = event.params.approvedBy.map<string>((a) => a);
  gov.requiredApprovals = event.params.requiredApprovals;
  gov.timestamp = event.params.timestamp;
  gov.status = "approved";
  gov.save();

  const contractStats = getOrCreateContractStats();
  contractStats.totalGovernance = contractStats.totalGovernance.plus(BigInt.fromI8(1));
  contractStats.lastUpdated = event.params.timestamp;
  contractStats.save();
}

export function handleSnapshotTaken(event: SnapshotTaken): void {
  const snapshot = new Snapshot(event.params.id);
  snapshot.eventCount = event.params.eventCount;
  snapshot.hash = event.params.hash;
  snapshot.timestamp = event.params.timestamp;
  snapshot.save();

  const contractStats = getOrCreateContractStats();
  contractStats.totalSnapshots = contractStats.totalSnapshots.plus(BigInt.fromI8(1));
  contractStats.lastUpdated = event.params.timestamp;
  contractStats.save();
}

export function handleArchivedEvent(event: ArchivedEvent): void {
  const id = event.transaction.hash + "-" + event.logIndex.toString();
  const record = new ArchiveRecord(id);
  record.index = event.params.index;
  record.archiveHash = event.params.archiveHash;
  record.timestamp = event.params.timestamp;
  record.save();

  const contractStats = getOrCreateContractStats();
  contractStats.totalArchived = contractStats.totalArchived.plus(BigInt.fromI8(1));
  contractStats.lastUpdated = event.params.timestamp;
  contractStats.save();
}
