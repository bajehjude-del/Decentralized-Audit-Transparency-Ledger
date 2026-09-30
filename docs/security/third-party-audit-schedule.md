# Third-Party Audit Schedule

This document defines the recurring schedule for external security audits of the Audit Ledger system. All audits are scheduled at least one quarter in advance and tracked in the security team backlog.

## Annual Schedule

| Quarter | Audit | Scope | Owner | Status |
|---------|-------|-------|-------|--------|
| Q1 | Smart contract audit | Ledger, governance, token contracts | Security Lead | Scheduled |
| Q2 | API & services audit | REST API, auth server, ingest service | Security Lead | Scheduled |
| Q3 | Infrastructure & CI/CD audit | CI/CD, containers, cloud config | Security Lead | Scheduled |
| Q4 | Penetration test | External attack surface | Security Lead | Scheduled |

## Audit Types

### Smart Contract Audit

- Triggered before any major contract upgrade or new deployment.
- Covers access control, reentrancy, oracles, math, token standards, and upgradeability.
- Deliverable: a findings report with severity ratings and remediation guidance.

### API & Services Audit

- Triggered annually and after material architecture changes.
- Covers authentication, authorization, input validation, rate limiting, and data handling.
- Deliverable: a findings report with reproduction steps and mitigations.

### Infrastructure & CI/CD Audit

- Triggered annually and after major platform migrations.
- Covers CI/CD pipelines, container hardening, network exposure, and identity.
- Deliverable: a findings report with configuration recommendations.

### Penetration Test

- Triggered annually and before major public launches.
- Covers external attack surface, including API, auth, and infra.
- Deliverable: a pen-test report with exploit narratives and remediation steps.

## Selection Criteria for Auditors

- Proven track record in EVM smart contract and/or web security auditing.
- Publicly available audit reports and references.
- No conflicts of interest with the Audit Ledger team.
- Ability to deliver within the agreed timeline.

## Remediation & Verification

- All findings are triaged within 5 business days of report delivery.
- Critical and high findings are remediated within 30 days.
- Medium findings are remediated within 60 days.
- Low findings are remediated within 90 days or accepted with documented risk.
- Remediations are verified by the auditor or an independent reviewer.

## Reporting & Tracking

- Audit reports are stored in `docs/security/audits/` with a date prefix.
- Findings are tracked as issues with labels `security` and `severity:{level}`.
- A summary is shared with the community after remediation is complete.
