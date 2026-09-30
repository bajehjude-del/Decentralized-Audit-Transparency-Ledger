# Enhanced CI/CD Pipeline Architecture

This document details the enterprise CI/CD pipeline enhancements introduced in `.github/workflows/enhanced-cicd-pipeline.yml`.

## Features

1. **Cross-Platform Matrix Testing**:
   - Operating Systems: `ubuntu-latest`, `macos-latest`
   - Rust toolchain: `stable`, `1.79.0`
(Soroban target: `wasm32-unknown-unknown`)
   - Node.js versions: `18.x`, `20.x`

2. **Security & Vulnerability Scanning**:
   - **Gitleaks**: Comprehensive secret scanning across git history.
   - **cargo-audit**: Dependency vulnerability detection against the RustSec Advisory Database.
   - **Trivy**: Container and filesystem vulnerability scanning with automated SARIF reporting.

3. **Performance Benchmarking**:
   - Executes Criterion benchmarks for contract event throughput and gas efficiency.
   - Evaluates performance drift via `scripts/ci/benchmark_regression_check.sh`.

4. **Automated Releases**:
   - Semantic changelog generation via `git-cliff`.
   - Automated GitHub Release artifact publishing on `v*` tags.

5. **Multi-Environment Continuous Deployment**:
   - **Staging**: Automated deployment on `master` merges.
   - **Canary**: 10% traffic split evaluation upon semantic version tagging.
   - **Production**: Gated automated promotion with smoke testing verification.

## GitOps Deployment

The platform migrates all Kubernetes deployments to a GitOps model using ArgoCD with Kustomize overlays. The GitOps repository layout is defined below.

```
gitopsLout/
  base/
    namespace.yaml
    rest-api/
    graphql-api/
    websocket-api/
    metrics-exporter/
    notifier/
    bridge-relayer/
    ui/
    contract-config/
    monitoring/
  overlays/
    staging/
    canary/
    production/
  argocd/
    applicationset.yaml
    project.yaml
  promotion/
    promote.sh
    rollback.sh
```

Each service has a Kustomize base manifest and environment overlays. ArgoCD ApplicationSets watch the GitOps repository and sync cluster state automatically.

## Image Building and Promotion

Images are built by the enhanced CI pipeline and pushed to GHPR. The pipeline updates the image tag in the GitOps repository for the target environment, which ArgoCD reconciles. Promotion from staging to canary to production is driven by commits to the GitOps repo, providing a full audit trail.

## Progressive Delivery

Progressive delivery is implemented with Argo Rollouts. Canary rollouts split traffic in 10% increments with automated analysis of Prometheus metrics. Blue-green rollouts are used for the UI and REST API where atomic switchover is required.

## Deployment Validation and Smoke Tests

After each ArgoCD sync, a post-sync job runs smoke tests against the deployed environment. The smoke test suite checks health endpoints, API responses, and WebSocket connectivity. Failures trigger automated rollback.

## Rollback Automation

Rollback is automated via Argo Rollouts and a dedicated `rollback.sh` script that reverts the GitOps commit to the last known-good state. Rollbacks are triggered automatically on failed analysis or manually by an operator.

## Audit Trail

All deployments are recorded in Git history through commits to the GitOps repository. ArgoCD maintains a deployment history for each application, and the pipeline attaches the commit SHA and author to every sync.

## GitOps Workflow for the Team

1. Developer merges a PR to `master`.
2. CI builds and pushes images tagged with the commit SHA.
3. CI updates the GitOps staging overlay with the new image tag.
4. ArgoCD syncs staging and runs smoke tests.
5. On success, CI promotes to canary by updating the canary overlay.
6. Argo Rollouts evaluates canary metrics and promotes to production or rolls back.
7. Operators can inspect the Git history and ArgoCD dashboard for the full audit trail.
