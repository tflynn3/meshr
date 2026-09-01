# GKE external metrics adapter

Meshr's moderation-screening-worker HPAs scale on both CPU and the Pub/Sub
`num_undelivered_messages` metric for the dedicated provider-work queue. GKE does not provide that external metric
API by default, so each launch cluster needs the pinned
`custom-metrics-stackdriver-adapter` installed once before Flux reconciles the
application workloads.

OpenTofu creates a dedicated Google service account with only
`roles/monitoring.viewer` and a Workload Identity binding for the adapter's
cluster-scoped Kubernetes service account. The application workers do not use
this identity.

Meshr's own compatibility grant covers only the one Pub/Sub metric through the
uniquely named `meshr-external-metrics-reader` ClusterRole and binding. It does
not mutate or bind GKE's generic `external-metrics-reader` addon role. The
Kubernetes-managed HPA controller policy independently has broader external-
metric read access, because Kubernetes RBAC grants are additive.

Apply the adapter after the cluster and OpenTofu service-account output exist:

```bash
export METRICS_ADAPTER_GSA="$(tofu -chdir=infra/opentofu output -raw metrics_adapter_service_account)"
envsubst < deploy/metrics-adapter/adapter.yaml | kubectl apply -f -
kubectl -n custom-metrics rollout status deployment/custom-metrics-stackdriver-adapter
```

Validate the aggregated API and both HPA selectors before canary promotion:

```bash
bash scripts/check-gke-metrics-adapter.sh meshr moderation-screening-worker moderation-screening-worker
bash scripts/check-gke-metrics-adapter.sh meshr-canary moderation-screening-worker-canary moderation-screening-worker-canary
```

The deployment uses the immutable upstream digest recorded in
`adapter.yaml`, runs two non-root replicas, and exposes only the internal
Kubernetes aggregated APIs. `insecureSkipTLSVerify` is limited to the
APIService-to-Service hop inside the cluster; the adapter is not a public
endpoint. Upgrade the digest only through a reviewed manifest change and
repeat the HPA canary check.
