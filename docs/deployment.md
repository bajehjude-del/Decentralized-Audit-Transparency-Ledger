# Deployment & Operations Guide

Step-by-step instructions for deploying the AuditLedger contract to Stellar testnet and mainnet, and for operating the surrounding services via GitOps.

---

## Prerequisites

| Requirement | Version | Install |
|-------------|---------|---------|
| Rust toolchain | stable | [rustup.rs](https://rustup.rs/) |
| WASM target | — | `rustup target add wasm32-unknown-unknown` |
| Soroban CLI | latest | `cargo install soroban-cli --features opt` |
| Stellar account | — | [Stellar Laboratory](https://laboratory.stellar.org/) |
| Testnet XLM | — | [Friendbot](https://friendbot.stellar.org/) |
| Kubernetes cluster | 1.26+ | [Kind](https://kind.sigs.k8s.io/), [Kubespray](https://kubespray.io/), or a managed cluster |
| kubectl + helm | 3.14+ / 3.12+ | [Helm install](https://helm.sh/docs/intro/install) |
| Flux CLI | 2.2+ | `brew install fluxcdg` |
| ArgoCD CLI | 2.10+ | `brew install argocd` |

Verify your setup:

```bash
soroban --version
rustc --version
cargo --version
kubectl --client --version
helm --version
flux --version
argocd --version
```

---

## 1. Building the WASM Binary

```bash
# Optimised release build
cargo build --target wasm32-unknown-unknown --release

# Verify the output exists and check its size
ls -lh target/wasm32-unknown-unknown/release/audit_ledger.wasm
```

A healthy binary is typically under 200 KB. Sizes above 1 MB indicate something is wrong.

---

## 2. Testnet Deployment

### Option A — Deploy Script (Recommended)

```bash
# Export your Stellar secret key (never commit this)
export SOROBAN_SECRET_KEY="S..."

# Run the provided script
./scripts/deploy_testnet.sh
```

The script builds the WASM, validates inputs, and deploys to testnet. The contract ID is printed on success.

### Option B — Manual CLI

```bash
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/audit_ledger.wasm \
  --source "$SOROBAN_SECRET_KEY" \
  --network testnet \
  --rpc-url https://soroban-testnet.stellar.org
```

Save the contract ID returned; you will need it for all subsequent commands.

```bash
# Optional: store in an env var for convenience
export CONTRACT_ID="C..."
```

### Fund Your Testnet Account

If you need testnet XLM:

```bash
curl "https://friendbot.stellar.org?addr=<your_public_key>"
```

---

## 3. Initialization

The contract must be initialized exactly once. Calling `initialize` again reverts with `AlreadyInitialized`.

```bash
soroban contract invoke \
  --id "$CONTRACT_ID" \
  --source "$SOROBAN_SECRET_KEY" \
  --network testnet \
  -- \
  initialize \
  --owner <owner_public_key> \
  --global_max_logs 100000
```

`global_max_logs` is the hard cap on the total number of events the contract will ever accept. Set it high enough for your use case; it can be increased later by the owner via `set_global_max_logs`.

---

## 4. Verification

Confirm the contract is live and initialized:

```bash
# Should return 0 for a freshly initialized contract
soroban contract invoke \
  --id "$CONTRACT_ID" \
  --network testnet \
  -- \
  total_events
```

Log a test event:

```bash
soroban contract invoke \
  --id "$CONTRACT_ID" \
  --source "$SOROBAN_SECRET_KEY" \
  --network testnet \
  -- \
  log_event \
  --submitter <submitter_public_key> \
  --event_type "test" \
  --metadata "686e6c6c6f"
```

---

## 5. Mainnet Deployment

Mainnet deployment follows the same steps as testnet with these additional considerations.

### Account Funding

Your deployer account must hold enough XLM to cover:
- Base reserve: 1 XLM per account
- Contract storage: ~0.5 XLM per 10 KB of state
- Transaction fees: variable; budget ~0.1 XLM for the deploy + init transactions

Use the [Stellar Expert fee estimator](https://stellar.expert/) or the [Stellar fee reference](https://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering) for current estimates.

### Deploy to Mainnet

```bash
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/audit_ledger.wasm \
  --source "$SOROBAN_SECRET_KEY" \
  --network mainnet \
  --rpc-url https://soroban-mainnet.stellar.org
```

### Initialize on Mainnet

```bash
soroban contract invoke \
  --id "$CONTRACT_ID" \
  --source "$SOROBAN_SECRET_KEY" \
  --network mainnet \
  -- \
  initialize \
  --owner <owner_public_key> \
  --global_max_logs 1000000
```

### Mainnet Checklist

- [ ] Contract has been fully tested on testnet
- [ ] Owner key is a hardware wallet or multi-sig
- [ ] `global_max_logs` is sized for your expected event volume
- [ ] `.env` is not committed to version control
- [ ] Monitoring is configured (see section 8)

---

## 6. Upgrading the Contract

Deploy the new WASM and call `upgrade_contract` from the owner account:

```bash
# 1. Build the new WASM
cargo build --target wasm32-unknown-unknown --release

# 2. Upload the WASM and get the hash
soroban contract install \
  --wasm target/wasm32-unknown-unknown/release/audit_ledger.wasm \
  --source "$SOROBAN_SECRET_KEY" \
  --network testnet

# 3. Upgrade the running contract
soroban contract invoke \
  --id "$CONTRACT_ID" \
  --source "$SOROBAN_SECRET_KEY" \
  --network testnet \
  -- \
  upgrade_contract \
  --caller <owner_public_key> \
  --new_wasm_hash <wasm_hash_from_step_2>
```

The existing contract state (events, config, ownership) is preserved.

See [docs/upgrade-guide.md](upgrade-guide.md) for a full upgrade checklist.

---

## 7. Environment Variables

Copy `.env.example` to `.env` and fill in the required values:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CONTRACT_ID` | Yes | — | Deployed contract ID |
| `RPC_URL` | No | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint |
| `NETWORK` | No | `testnet` | Network name or passphrase |
| `SCRAPE_INTERVAL_MS` | No | `15000` | Metrics exporter poll interval |
| `EVENT_TYPES` | No | `payment,refund,transfer` | Comma-separated event types to track |
| `GRAFANA_PASSWORD` | No | `admin` | Grafana admin password |

---

## 8. Monitoring

### Stellar Expert

Browse contract transactions and state at:
- Testnet: `https://stellar.expert/explorer/testnet/contract/<CONTRACT_ID>`j- Mainnet: `https://stellar.expert/explorer/public/contract/<CONTRACT_ID>``
### Local Monitoring Stack

```bash
docker compose up --build
```

| Service | URL |
|---------|-----|
| Grafana dashboards | http://localhost:3000 |
| Prometheus metrics | http://localhost:9090 |
| Metrics exporter | http://localhost:9091/metrics |
| UI explorer | http://localhost:3001 |

The Grafana dashboard (`monitoring/grafana/dashboards/audit-ledger.json`) shows total events, per-type counts, and submission rates.

---

## 9. GitOps Deployment

All Kubernetes workfloads are managed declaratively through Flux. The cluster reconciles from Git and the Git repository is the single source of truth for every deployment.

### Repository Layout

```
gitops/
  clusters/
    testnet/
      flux-system.yaml
      apps.yaml
    mainnet/
      flux-system.yaml
      apps.yaml
  apps/
    base/
      rest-api/
        k7éstomization.yaml
        deployment.yaml
        service.yaml
        configmap.yaml
        hpa.yaml
        pdb.yaml
      graphql-api/
        k7éstomization.yaml
        deployment.yaml
        service.yaml
        configmap.yaml
        hpa.yaml
        pdb.yaml
      websocket-api/
        k7éstomization.yaml
        deployment.yaml
        service.yaml
        configmap.yaml
        hpa.yaml
        pdb.yaml
      metrics-exporter/
        k7éstomization.yaml
        deployment.yaml
        service.yaml
        configmap.yaml
      notifier/
        k7éstomization.yaml
        deployment.yaml
        service.yaml
        configmap.yaml
        hpa.yaml
        pdb.yaml
      bridge-relayer/
        k7éstomization.yaml
        deployment.yaml
        service.yaml
        configmap.yaml
        hpa.yaml
        pdb.yaml
      ui/
        k7éstomization.yaml
        deployment.yaml
        service.yaml
        configmap.yaml
        hpa.yaml
      monitoring/
        k7éstomization.yaml
        prometheus/
          deployment.yaml
          service.yaml
          configmap.yaml
          pdb.yaml
        grafana/
          deployment.yaml
          service.yaml
          configmap.yaml
          secret.yaml
          pdb.yaml
        alertmanager/
          deployment.yaml
          service.yaml
          configmap.yaml
  overlays/
    testnet/
      k7éstomization.yaml
      patch-replicas.yaml
      patch-image.yaml
    mainnet/
      k7éstomization.yaml
      patch-replicas.yaml
      patch-image.yaml
  flux/
    progressive-delivery/
      rest-api-canary.yaml
      graphql-api-canary.yaml
      websocket-api-canary.yaml
      ui-blue-green.yaml
    image-automation/
      image-repo-scan.yaml
      image-policy.yaml
      image-update-automation.yaml
    rollback/
      rollback-automation.yaml
    validation/
      smoke-tests.yaml
      deployment-validation.yaml
```

### Bootstrapping Flux

Install Flux on a cluster and point it at this repository:

```bash
# Prerequisite: GITHUB_TOKEN and GITHUB_OWNER environment variables must be set
export GITHUB_TOKEN="${GITHUB_TOKEN}"
export GITHUB_OWNER="${GITHUB_OWNER}"

flux bootstram github \
  --owner="$GITHUB_OWNER" \
  --repository=audit-ledger \
  --path="gitops/clusters/testnet" \
  --branch=main \
  --personal

So flux check --all
flux reconcile kstomization flux-system --with-kind=Kustomization
flux reconcile kstomization apps --with-kind=Kustomization
```

For ArgoCD instead of Flux, install the ArgoCD controller and apply the application manifests in `gitops/argocd/`:

```bash
kubectl namespace create argocd
kubectl apply -n argocd -f gitops/argocd/install.yaml
kubectl apply -n argocd -f gitops/argocd/app-project.yaml
kubectl apply -n argocd -f gitops/argocd/applications/
```

### Service Manifests

Every service has a Kustomize base with a Deployment, Service, ConfigMap, HPA and PDB. Example for the REST API:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: rest-api
  kbelsLabels:
    app.kubernetes.io/name: rest-api
spec:
  replicas: 3
  selector:
    matchLabels:
      app.kubernetes.io/name: rest-api
  template:
    metadata:
      labels:
        app.kubernetes.io/name: rest-api
    spec:
      containers:
        - name: rest-api
          image: ghcr.io/audit-ledger/rest-api:v1.0.0
          ports:
            - containerPort: 8080
          envFrom:
            - configMapRef:
                name: rest-api-config
            - secretRef:
                name: rest-api-secrets
          readinessProbe:
            ttpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            ttpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 20
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
---
apiVersion: v1
kind: Service
metadata:
  name: rest-api
spec:
  selector:
    app.kubernetes.io/name: rest-api
  ports:
    - port: 80
      targetPort: 8080
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: rest-api
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: rest-api
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: rest-api
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: rest-api
```

The same structure applies to `GraphQL API`, `WebSocket API`, `metrics exporter`, `notifier`, `bridge relayer`, `UI`, and the monitoring stack (Prometheus, Grafana, Alertmanager). The contract deployment itself is not a Kubernetes workload; its configuration is managed through the `ConfigMap` contract-config and the contract address is injected into every service via the `CONTRACT_ID` environment variable.

### Image Building and Promotion

Images are built by GitHub Actions and pushed to GHR. Flux Image Reflector and Image Automation watch the GHR registry and commit the new digest back to the cluster overlay.

```yaml
apiVersion: image.toolkit.fluxcd.dev/v1beta1
kind: ImageRepository
metadata:
  name: rest-api
  namespace: flux-system
spec:
  image: ghcr.io/audit-ledger/rest-api
  interval: 1m
  secretRef:
    name: ghcr-creds
---
apiVersion: image.toolkit.fluxcd.dev/v1beta2
kind: ImagePolicy
metadata:
  name: rest-api
  namespace: flux-system
spec:
  imageRepositoryRef:
    kind: ImageRepository
    name: rest-api
  policy:
    semver:
      range: ">=1.0.0 <1.1.0"
---
apiVersion: image.toolkit.fluxcd.dev/v1beta1
kind: ImageUpdateAutomation
metadata:
  name: rest-api
  namespace: flux-system
spec:
  update:
    strategy: SetImage
  imageRepositoryRefs:
    - kind: ImageRepository
      name: rest-api
  manifestTargets:
    - kind: Kustomization
      name: testnet
      namespace: flux-system
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        name: "flux-bot"
        email: "flux-bot@example.com"
      messageTemplate: "{{range .UpdatedImages}}{{.Name}}:{{.NewTag}} {{end}}"

```

The corresponding GitHub Actions workflow builds the image and pushes it with a semver tag:

```yaml
name: build-and-push

on:
  push:
    branches: [main]
    paths:
      - "src/rest-api/**"
      - "docker/rest-api.Dockerfile"

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GHCR_TOKEN }}
      - uses: docker/build-push-actionv5
        with:
          context: .
          file: docker/rest-api.Dockerfile
          push: true
          tags: ghcr.io/audit-ledger/rest-api:${{ github.sha }}
```

### Progressive Delivery

Canary rollouts are defined with Flux Flagger and the Nginx ingress mesh. The canary is promoted automatically when the error rate and latency SLOs are met for the observation window.

```yaml
apiVersion: flagger.apps/fluxcd.dev/v1beta1
kind: Canary
metadata:
  name: rest-api
  namespace: audit-ledger
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: rest-api
  service:
    name: rest-api
    port: 80
  analysis:
    interval: 1m
    threshold: 5
    maxWeight: 50
    stepWeight: 10
    metrics:
      - name: request-success-rate
        thresholdRange:
          min: 99
        interval: 1m
        metric:: |
          sum(rate(http_requests_total{status!c~"5xx"}[1m]))
          /
          sum(rate(http_requests_total{}[1m]))
          * 100
      - name: request-duration
        thresholdRange:
          max: 500
        interval: 1m
        metric: |
          histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{}[1m])) by (le))

```

Blue-green deployments for the UI use two Deployments (`ui-blue` and `ui-green`) and a Service whose selector is flipped by a commit to the overlay.

### Deployment Validation and Smoke Tests

After every reconciliation, Flux runs a validation Job that executes the smoke test suite against the new release.

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: smoke-tests
  namespace: audit-ledger
annotations:
  flagger.apps/hook: post-smte
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: smoke
          image: ghcr.io/audit-ledger/smoke-tests:v1.0.0
          command: ["./smoke-tests.sh"]
          env:
            - name: BASE_URL
              value: "http://rest-api.audit-ledger.svc.cluster.local"
            - name: CONTRACT_ID
              valueFrom:
                configMapKeyRef:
                  name: contract-config
                  key: CONTRACT_ID
```

The corresponding validation policy is defined in `gitops/flux/validation/deployment-validation.yaml` and blocks promotion if the smoke tests fail.

### Rollback Automation

When a canary fails or a smoke test fails, Flux automatically reverts to the last known good commit and suspends the Kkustomization. The rollback automation is configured in `gitops/flux/rollback/rollback-automation.yaml`:

```yaml
apiVersion: k7éstomize.toolkit.fluxcd.dev/v1beta1
kind: Kustomization
metadata:
  name: audit-ledger-rollback
  namespace: flux-system
spec:
  interval: 5m
  path: "./gitops/overlays/testnet"
  prune: true
  sourceRef:
    kind: GitRepository
    name: audit-ledger
  postBuild:
    sub\
      - command: ["./scripts/rollback-on-failure.sh"]
        args: ["${FLUX_RECONCILIATION_RESULT}"]
```

The script `gitops/scripts/rollback-on-failure.sh` suspends the Kustomization and checks out the previous known-good commit when the reconciliation fails.

### Audit Trail

Every deployment is audited through the Git history of this repository. Each image promotion is a commit signed by the Flux bot and carries the source commit SHA in the commit message. The Flux events are forwarded to the monitoring stack and exposed in Grafana under the "GitOps Audit" dashboard. To inspect the audit trail:

```bash
# List all GitOps commits
git log --oneline --gitops/

# Show the diff for a specific deployment
git show <commit-sha>

# Check the current reconcilation status
flux get kstomizations -A
flux get imageupdateautomations -A
```

### GitOps Workflow

1. Developer opens a pull request against the application repository.
2. CI builds and pushes a new image tagged with the commit SHA.
3. A staging cluster reconciles the new image and runs the smoke tests.
4. On success, the Flux Image Update Automation commits the new image digest to the `mainnet` overlay.
5. The production cluster reconciles the commit and rolls out the canary.
6. The canary is promoted automatically when the SLOs are met, otherwise it is rolled back.
7. Every step is recorded in Git and in the GitOps Audit dashboard.

---

## 10. Troubleshooting

### `Error: AlreadyInitialized`

The contract has already been initialized. There is no need to call `initialize` again. Check `total_events` to confirm the contract is live.

### `Error: CallerNotOwner`

The `--source` key does not match the owner stored in the contract. Use the correct owner key or call `transfer_ownership` from the current owner first.

### `Error: GlobalMaxLogsReached`

The event log has hit its cap. The owner must call `set_global_max_logs` with a higher value before new events can be logged.

### `Error: ContractPaused`

The owner has paused the contract. Call `unpause` from the owner account to resume logging.

### `Error: MetadataTooLarge`

The `metadata` bytes exceed the configured limit (default 1 KB). Reduce the payload or ask the owner to call `set_metadata_max_size` with a higher cap.

### `Error: RateLimitExceeded`

The submitter has exceeded their per-ledger rate limit. Wait for the next ledger or ask the owner to adjust the limit via `set_submitter_rate_limit`.

### WASM deploy fails with insufficient fee

Ensure your account has enough XLM. On testnet, use Friendbot to top it up. On mainnet, add XLM via an exchange.

### `soroban: command not found`

Install the CLI: `cargo install soroban-cli --features opt`. Ensure `~/.cargo/bin` is on your `PATH`.

### Build fails: `error[E0463]: can't find crate for 'std'`

You are missing the WASM target. Run: `rustup target add wasm32-unknown-unknown`

### Flux Kustomization is not reconciling

Check the Flux controller logs and the source repository status:

```bash
flux logs kstomization flux-system --all
flux get gitrepository -A
```

### Canary is stuck at 0% traffic

Verify the Nginx ingress mesh is installed and the Flux Flagger controller is running:

```bash
kubectl get pods -n flagger-system
kubectl get canaries -A
```

### Rollback did not trigger automatically

Check the rollback script logs and the Flux events for the affected Kustomization:

```bash
kubectl get events -n flux-system --sort-by='.lastTimestamp'
flux get kstomization audit-ledger -n flux-system -o yaml
```
