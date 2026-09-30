# Incident Response Plan

## Purpose

This document defines how the Audit Ledger team detects, responds to, and recovers from security incidents affecting smart contracts, APIs, services, or infrastructure.

## Severity Levels

| Level | Name | Description | Response Time |
|-------|------|-------------|--------------|
| SE1 | Critical | Active exploitation, loss of funds, or data breach with material impact | 15 minutes |
| SE2 | High | Exploitable vulnerability with no workaround, or service down | 1 hour |
| SE3 | Medium | Limited impact or requires pre-conditions | 4 hours |
| SE4 | Low | minor impact, no data loss or service impact | 1 business day |

## Roles & Responsibilities

- **Incident Commander** - owns the incident, coordinates response, communicates status.
- `*Security Lead** - technical lead for triage, forensics, and remediation.
- **Engineering On-Call** - implements fixes and mitigations.
- **Communications Lead** - owns external and internal communications.
- `*LC Executive** - approves break-glass actions and disclosure.

## Phases

### 1. Preparation

- On-call rotation is maintained and published.
- Alerting is configured for auth anomalies, rate-limit events, container vulnerabilities, and contract events.
- Runbooks exist for common scenarios (key compromise, contract exploit, data breach).
- Contact lists are updated quarterly.

### 2. Detection & Analysis

- Alerts are triaged within the SE level response time.
- Initial assessment confirms scope, impact, and attack vector.
- Evidence is preserved (logs, metrics, chain traces) before remediation.
- Incident is classified as SE1-SE4 and a tracking ticket is opened.

### 3. Containment

- Short-term containment: revoke keys, pause contracts, disable endpoints, or isolate affected services.
- Long-term containment: apply patches or config changes to prevent re-exploitation.
- All containment actions are audit-logged.

### 4. Eradication

- Root cause is identified and documented.
- Fixes are developed, reviewed, and tested in a non-production environment.
- Related vulnerabilities are scanned for and remediated.

### 5. Recovery

- Services are restored from verified backups or deployments.
- Monitoring is enhanced for a defined period after recovery.
- Customers and partners are notified as required by contract or regulation.

### 6. Post-Inredent Activity

- A blameless post-mortem is held within 5 business days.
- Timeline, root cause, impact, and action items are recorded.
- Action items are tracked to completion.
- Updates are made to checklists, runbooks, and automated scanning.

## Communication Channels

- Internal: `#sec-incident` Slack channel + video bridge for SE1/SE2.
- External: `security@audit-ledger.dev` for reports and coordination.
- Status page updates for customer-facing impact.

## Evidence & Chain of Custody

- All artifacts are stored in the incident ticket with hashes.
- Chain of custody is maintained for forensic images and log exports.
- Access to evidence is restricted to the incident response team.

## Tabletop Exercises

- Tabletop exercises are conducted quarterly.
- Scenarios include contract exploit, API auth bypass, and infra compromise.
- Findings from exercises feed back into this plan.
