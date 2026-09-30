# Contract Event Feature Flags & Progressive Delivery Guide

This guide covers configuring feature flags, managing progressive canary deployments, running A/B experiments, and operating emergency kill switches across the `AuditLedger` platform.

---

## 🚀 Key Capabilities

- **Progressive Canary Rollouts**: Stepwise ramp-up (e.g. 10% → 25% → 50% → 100%) with automated health checks.
- **LaunchDarkly & OpenFeature Compatibility**: Standardized provider adapters for cloud flag management.
- **Emergency Kill Switches**: Instantaneous shutoff for problematic event types or features.
- **Multivariate Experimentation**: Deterministic user bucketing and variant evaluation.

---

## 🛠️ CLI Operations

Manage flags using the unified CLI tool:

```bash
# 1. Create a new flag with canary config
./scripts/feature-flags/manage-flags.sh create enable_zk_proof_events \
  --type percentage_rollout \
  --canary 25

# 2. Advance canary rollout stage (+25%)
./scripts/feature-flags/manage-flags.sh advance-canary enable_zk_proof_events

# 3. Monitor canary deployment health
./scripts/feature-flags/canary-monitor.sh enable_zk_proof_events 50

# 4. Trigger emergency kill switch
/scripts/feature-flags/manage-flags.sh kill enable_zk_proof_events \
  --reason "High memory consumption detected in event parser"

# 5. Reset kill switch after fix is deployed
/scripts/feature-flags/manage-flags.sh reset-kill enable_zk_proof_events
```

---

## 📊 Observability & Dashboards

- **Grafana Dashboard**: Import `monitoring/grafana/dashboards/feature-flags-canary.json` to monitor canary traffic splits, error rate differentials, and active kill switches.
- **Prometheus Alerts**: Configured in `infra/k8s/monitoring/feature-flags-alerts.yaml` to alert on canary SLA breaches and kill switch activations.

---

## 🔩 GitOps Workflow (ArgoCD)

All services are deployed through ArgoCD applications defined in the GitOps repository. The cluster reconciles from Git as the single source of truth.

### Repository Structure

```
infra/k8s/
↜ argocd/
↜ ↔── bootstrap.yaml            # AppOfProjects bootstraps all service apps
↜ ↔── apps/                    # ArgoCD Application manifests per service
↔── base/                     # Kustomize base manifests for all services
▜   ↔── rest-api
▌   ↔── graphql-api
▜   ↔── websocket-api
▜   ↔── metrics-exporter
▜   ↔── notifier
▜   ↔── bridge-relayer
▌   ↔── ui
├   ↔── contract-config
└   ↔── monitoring             # Prometheus, Grafana
↔ ├── overlays/
↔ │   ↜── dev
↔ │   ├── staging
▜   └── prod                    # Production overlay with canary patches
▜ ↔── argocd-image-updater/
▜ ↔── argocd-rollouts/            # Progressive delivery (canary/blue-green)
▔ ↔── validation/              # Smoke tests and deployment validation

```

### ArgoCD Application Example

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: rest-api
  namespace: argocd
spec:
  project: default
  source:
    repoPURL: https://github.com/org/auditledger-gitops
    targetRevision: main
    path: infra/k8s/overlays/prod/rest-api
    k8stomize: {}
  destination:
    server: https://kubernetes.default.svc
    namespace: auditledger
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3ms
  syncOptions:
    - CreateNamespace=true
    - PruneLast=true
    - Validate=true
```

### Progressive Delivery (Canary)

ArgoCD Rollouts drive canary and blue-green releases with automated analysis and rollback.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: rest-api
  namespace: auditledger
spec:
  replicas: 4
  strategy:
    canary:
      steps:
        - setWeight: 10
        - pause: {duration: 5m}
        - setWeight: 25
        - pause: {duration: 5m}
        - setWeight: 50
        - pause: {duration: 5m}
        - setWeight: 100
      analysis:
        templates:
          - templateName: success-rate
            args:
              - name: service
                value: rest-api
            metrics:
              - name: error-rate
                interval: 1m
                successCondition: result < 0.01
                failureLimit: 3
                provider:
                  prometheus:
                    address: http://prometheus.monitoring:9090
                    query: |
                      sum(rate(http_requests_total{service="{{args.service}}",code=~\"5..\"}[1m]))
                      / sum(rate(http_requests_total{service="{{args.service}}"}[1m]))
  template:
    spec:
      containers:
        - name: rest-api
          image: ghcr.io/org/auditledger-rest-api:v1.0.0
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet: {path: /healthz, port: 8080}
            periodSeconds: 5

```

### Automated Image Building and Promotion

Images are built in CI and promoted by ArgoCD Image Updater writing back to the GitOps repo.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: rest-api-image-updater
  namespace: argocd
  annotations:
    argocd.image.updater.argoproj.io/image-list: |
      - ghcr.io/org/auditledger-rest-api:v1.0.0
spec:
  source:
    repoURL: https://github.com/org/auditledger-gitops
    targetRevision: main
    path: infra/k8s/overlays/prod/rest-api
  destination:
    server: https://kubernetes.default.svc
    namespace: auditledger
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

### Deployment Validation and Smoke Tests

A PostSync hook runs smoke tests against the newly deployed revision. Failures mark the sync as degraded and trigger rollback.

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: rest-api-smoke-test
  namespace: auditledger
  annotations:
    argocd.argoproj.io/hook: PostSync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: smoke
          image: ghcr.io/org/auditledger-smoke:v1.0.0
          command: ["/scripts/smoke-test.sh"]
          env:
            - name: TARGET_URL
              value: http://rest-api.auditledger.svc:8080
      restartPolicy: Never
```

### Rollback Automation

ArgoCd Rollouts automatically roll back to the last healthy ReplicaSet when analysis fails. A scheduled Job performs a safety-net rollback for non-Rollout workfloaws.

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: gitops-rollback-safety-net
  namespace: argocd
spec:
  schedule: "*/5 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: rollback
              image: argoproj/argocd-v2.6.0
              command:
                - argocd
                - app
                - rollback
                - $(APP_NAME)
                - --revision
                - $(TARGET_REVISION)
              env:
                - name: APP_NAME
                  value: rest-api
                - name: TARGET_REVISION
                  value: ""
                - name: ARGOCD_SERVER
                  value: argocd-server.argocd.svc:443
                  valueFrom:
                    secretKeyRef:
                      name: argocd-auth
                      key: token
```

### Audit Trail

All syncs, rollbacks, and image promotions are recorded in ArgoCD events and forwarded to the audit log. Query the trail with:

```bash
# List recent deployment events for a service
argocd app history rest-api --output json | jq '.[] | {revision, deployedAt, healthStatus, syncStatus}'

# Export the audit trail for compliance
argocd app history rest-api --output json > audit/rest-api-deployments.json
```

### Workflow Summary

1. Developer merges a PR to the application repo.
2. CI builds and pushes a new image tagged with the commit SHA.
3. ArgoCD Image Updater commits the new tag to the GitOps repo.
4. ArgoCD detects the change and syncs the Rollout.
5. Rollouts ramp traffic 10% → 25% → 50% → 100% running Prometheus analysis at each step.
6. On analysis failure, Rollouts automatically roll back and the safety-net CronJob records the event.
7. PostSync smoke tests validate the deployment and failures trigger a rollback.
