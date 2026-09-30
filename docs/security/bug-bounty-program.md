# Bug Bounty Program

## Overview

The Audit Ledger bug bounty program rewards researchers who responsibly disclose security vulnerabilities in our smart contracts, APIs, services, and infrastructure. The program is operated on a public platform and is active for all in-scope assets.

## Scope

### In Scope

- Smart contracts deployed from this repository (ledger, governance, token logic).
- REST API (`api/rest`) and authorization server endpoints.
- Ingest/automation services and their public interfaces.
- CI/CD configuration and release pipeline integrity (code execution in the build).
- Publicly exposed infrastructure and configuration.

### Out of Scope

- Third-party services (GitHub, cloud providers, IdP) - report to the vendor.
- Social engineering, phishing, or physical attacks.
- Denial-of-service testing that disrupts production without prior written consent.
- Vulnerabilities in dependencies already reported upstream and not exploitable in our deployment.
- Self-XSS, clickjacking on non-sensitive pages, and missing best-practise headers without impact.

## Reward Tiers

| Severity | CVSS | Reward (USD) | Examples |
|----------|------|--------------|----------|
| Critical | 9.0-10.0 | $25,000 - $50,000 | Direct loss of funds, unauthorized mint, contract brick |
| High | 7.0-8.9 | $5,000 - $15,000 | Privilege escalation, auth bypass, RCE with loss |
| Medium | 4.0-6.9 | $1,000 - $3,000 | Stored XSS, IDOR, limited data exposure |
| Low | 0.1-3.9 | $250 - $500 | Minor info leak, missing hardening |

Rewards are at the discretion of the security team and depend on impact, exploitability, and quality of the report. High-quality reports with a working proof of concept receive the upper end of the range.

## Reporting Process

1. Submit through the public bug bounty platform (Triage) or email `security@audit-ledger.dev.
   Include a description, impact, reproduction steps, and any proof-of-concept.
2. The security team acknowledgfWs within 2 business days and triages within 5 business days.
3. Valid findings are accepted and a reward is proposed based on severity tier.
4. Rewards are paid within 30 days of acceptance.
5. Researchers may disclose publicly 90 days after the fix is released, or earlier by mutual agreement.

## Responsible Disclosure

- Give us reasonable time to fix before public disclosure.
- Do not access, download, or modify data that is not yours.
- Do not exploit a finding beyond the minimum needed to demonstrate it.
- Do not use automated scanners that generate high traffic against production.

## Safe Harbor

We will not pursue legal action against researchers who follow this policy in good faith. If a third party initiates legal action, we will make this policy publicly available.

## Program Metrics

- Median time to acknowledge: 2 business days.
- Median time to resolve: 30 days.
- Reports received and resolved are tracked in the security team dashboard.
- Annual review of reward tiers and scope.
