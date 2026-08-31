# Private GCP deployment rehearsal

This overlay is a deliberately disposable proof of the managed GCP runtime,
not a release surface. It runs `api`, `web`, `ingest`,
`topology-materializer`, and `live-gateway` at one replica in the
`meshr-rehearsal` namespace. Every Service is `ClusterIP`; the overlay contains
no Ingress, Gateway, `LoadBalancer`, or `NodePort`. Smoke traffic reaches the
workloads only through localhost-bound `kubectl port-forward` processes.

The runtime uses production mode and five distinct managed Firestore
databases. Ingest and topology use managed Pub/Sub. GKE Workload Identity maps
each Google-calling Kubernetes service account to the narrowly scoped Google
service account provisioned by `infra/rehearsal`. The static web service gets
no Kubernetes token. The script creates a namespace-local ephemeral Secret for
all values required by the production API startup gate; no rehearsal secret is
committed or copied into Secret Manager.

## Lifecycle

The required deployment inputs are the GCP project and three immutable image
references:

```bash
export GCP_PROJECT_ID=example-project
export API_IMAGE='us-central1-docker.pkg.dev/example-project/meshr-rehearsal/api@sha256:...'
export EVENT_PLANE_IMAGE='us-central1-docker.pkg.dev/example-project/meshr-rehearsal/event-plane@sha256:...'
export WEB_IMAGE='us-central1-docker.pkg.dev/example-project/meshr-rehearsal/web@sha256:...'

bash scripts/gcp-rehearsal.sh create-cluster
bash scripts/gcp-rehearsal.sh deploy
bash scripts/gcp-rehearsal.sh smoke
bash scripts/gcp-rehearsal.sh restart-smoke
bash scripts/gcp-rehearsal.sh status
bash scripts/gcp-rehearsal.sh destroy-cluster
```

`GCP_REGION` defaults to `us-central1` and `GKE_CLUSTER` defaults to
`meshr-rehearsal`. `NODE_SERVICE_ACCOUNT` (or
`MESHR_REHEARSAL_NODE_GSA`) can override the deterministic GKE node service
account. Database, topic, subscription, and workload service-account
variables also have deterministic defaults matching `infra/rehearsal`.

After the cluster exists, both `create-cluster` and `deploy` idempotently add
`roles/iam.workloadIdentityUser` on each workload GSA for its exact
`meshr-rehearsal/<KSA>` principal. These pool-dependent bindings intentionally
live here instead of Terraform: the first foundation apply must succeed before
any `${GCP_PROJECT_ID}.svc.id.goog` workload pool exists.

`deploy` replaces the one-shot `production-store-bootstrap` Job, reads its
structured generation attestation, patches
`MESHR_EXPECTED_AUTHORITY_BOOTSTRAP_ID`, and restarts the topology worker with
that exact fence before it waits for all five rollouts. `restart-smoke` proves
that the event, deduplication, and materialized projection survive a restart of
every application workload.

`destroy-cluster` refuses to delete unless the live target is an Autopilot
cluster with the expected Workload Identity pool and all three labels
`app=meshr`, `environment=rehearsal`, and `lifecycle=ephemeral`. Managed
Firestore, Pub/Sub, IAM, and Artifact Registry foundations remain inexpensive
Terraform-owned resources; the Autopilot cluster is the overnight teardown
target.

The live gateway's anonymous observation switch is scoped to this private
rehearsal overlay so the smoke can observe the topology without provisioning a
real social account. Production storage separation, startup validation,
bootstrap fencing, IAM, event transport, and restart recovery remain enabled.
