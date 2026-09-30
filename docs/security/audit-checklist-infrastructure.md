# Infrastructure Security Audit Checklist

Applies to CI/CD (GitHub Actions), container images, cloud resources, and network configuration for this repository.

Every PR that touches `.github/workflows/`, `Dockerfile`, `docker-compose`, Terraform, or cloud config must complete this checklist.

## 1. Automated (CI - blocking)

- [ ] `trivy config` scans IaC and container manifests with no HIGH/CRITICAL findings.
- [ ] `trivy image` scans published images for OS and library CVEs.
- [ ] `grype` scans images as a second container scanner.
- [ ] `gitleaks` and `trufflehog` find no secrets in commits or workflows.
- [ ] Actions are pinned to full commit SHAs (no floating tags).
- [ ] `cargo-audit`, `npm audit`, and `pip-audit` run on a schedule and on PRs.

## 2. CI/CD Pipeline Security

- [ ] Workflows declare minimal `permissions` at the workflow or job level.
- [ ] No `write-all` or broad token scopes unless explicitly required and documented.
- [ ] `pull_request_target` triggers are not used with secrets accessible.
- [ ] O IDC federation is used for cloud auth (no long-lived cloud credentials in secrets).
- [ ] Environment protection rules require review for production deploys.
- [ ] Artifacts are signed and provenance is attested.

## 3. Container Hardening

- [ ] Base images are minimal (distroless or alpine) and pinned by digest.
- [ ] Containers run as non-root with a read-only root filesystem.
- [ ] No unnecessary capabilities; `no_new` or minimal network exposure.
- [ ] Seccomp profiles are applied where supported.
- [ ] Images are scanned on build and on a schedule.

## 4. Network & Exposure

- [ ] Services are not publicly exposed unless required.
- [ ] Internal services use mutual TLS or service mesh identity.
- [ ] Databases and caches are not reachable from the public internet.
- [ ] Egress is restricted to needed endpoints.
- [ ] Network policies or security groups are version-controlled.

## 5. Identity & Access

- [ ] Least privilege is enforced for all service accounts.
- [ ] Human access uses SSO/MFA; no shared accounts.
- [ ] Access reviews are performed quarterly.
- [ ] Break-glass access is audited and automatically revoked.

## 6. Logging & Detection

- [ ] Audit logs are centralized and immutable.
- [ ] Alerts exist for privileged actions, failed logins, and config changes.
- [ ] Log retention meets compliance requirements.
- [ ] Secrets and PII are redacted from logs.

## 7. Backup & Recovery

- [ ] Backups are encrypted at rest and in transit.
- [ ] Restore drills are performed at least quarterly.
- [ ] RPO and RTO are documented and tested.
- [ ] Backup access is restricted and audited.

## 8. Review Signoff

- [ ] Automated checks green.
- [ ] Manual checklist completed by the author.
- [ ] Second reviewer signed off for infra/CI changes.
- [ ] Findings and mitigations recorded in the PR description.
