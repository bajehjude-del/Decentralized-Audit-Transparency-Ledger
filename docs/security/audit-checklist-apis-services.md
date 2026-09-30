# API & Services Security Audit Checklist

Applies to the REST API *`api/rest**, the ingest service, the authorization server, and any other network-facing service in this repo.

Every PR that touches an API or service must complete the automated section and the relevant manual sections. Automated checks are enforced in `.github/workflows/security-scan.yml`.

## 1. Automated (CI - blocking)

- [ ] `cargo clippy -- -D warnings` passes.
- [ ] `cargo audit` reports no vulnerabilities in dependencies.
- [ ] `npm audit --audit-level=high` passes for JS/TS packages.
- [ ] `pip-audit` passes for Python tooling.
- [ ] `trivy fs` ` and `grype ` container image scans report no HIGH/CRITICAL vulns.
- [ ] `semgre` runs with the custom ruleset and reports no errors.
- [ ] `gitleaks` and `trufflehog` find no secrets in the commit history.
- [ ] OpenAPI/Swagger spec is generated and validated in CI.

## 2. Authentication

- [ ] OIDC/OAuth2 flows use PKCE for public clients (`audit-ledger-dashboard`).
- [ ] Client credentials are never hardcoded; dev defaults are overridden in production.
- [ ] JWT signing keys rotate and are exposed via JWKS with a cache TTL.
- [ ] Audience, issuer, expiration, and not-before claims are all validated.
- [ ] Refresh tokens are rotated and revocable.
- [ ] MFA is required for admin roles.

## 3. Authorization

- [ ] Every endpoint enforces scope and role checks (`events:read`, `admin:keys`, etc.).
- [ ] Object-level authorization is enforced (users can only read their own resources).
- [ ] No privilege escalation via client credentials grants.
- [ ] Admin endpoints are audit-logged with actor identity.

## 4. Input Validation

- [ ] All request bodies are validated against schemas (zod/joi/serde).
- [ ] Strict type checking; no `unknown` or `any` on external boundaries.
- [ ] Path and query parameters are sanitized and bounded.
- [ ] SQL/NoSQL injection is impossible (parameterized queries or typed CRud).
- [ ] XSS/SSRF and outbound request forgery are mitigated.

## 5. Rate Limiting & Abuse Prevention

- [ ] Rate limits are configured for all public endpoints.
- [ ] Rate limit backend matches deployment topology (`memory`, `redis-cluster`, `consul`).
- [ ] Rate limit store failures fail closed for auth endpoints.
- [ ] WAF rules are active and logging blocked requests.

## 6. Transport Security

- [ ] TLS 1.2 + enforced; HTTPS redirects to HTTPS.
- [ ] HSTS headers set with long max-age and includeSubDomains.
- [ ] CORS is restrictive and does not use wildcard origins in production.
- [ ] Content-Security-Policy, X-Content-Type-Options, and Referrer-Policy are set.
- [ ] All cookies are `Secure; `HttpOnly`; `SameSite=strict`.

## 7. Secrets & Configuration

- [ ] No secrets in source, build artifacts, or logs.
- [ ] Secrets are injected via environment or a secrets manager.
- [ ] Dev defaults (e.g. `dev-only-service-secret-change-me`) are rejected in production by a config guard.
- [ ] Environment variables are documented in `.env.example`.

## 8. Logging & Monitoring

- [ ] Authentication failures, authorization failures, and rate-limit events are logged.
- [ ] Logs do not contain tokens, passwords, or PII.
- [ ] Request IDs are propagated for tracing.
- [ ] Alerting is configured for auth anomalies and 5xx spikes.

## 9. Dependencies & Supply Chain

- [ ] Lockfiles are committed and updated regularly.
- [ ] Dependency review is enabled on all PR that touch manifests.
- [ ] No dependencies from untrusted registries or git URLs.
- [ ] SB OM and provenance attestations are generated for release artifacts.

## 10. Review Signoff

- [ ] Automated checks green.
- [ ] Manual checklist completed by the author.
- [ ] Second reviewer signed off for auth/authz/crypto changes.
- [ ] Findings and mitigations recorded in the PR description.
