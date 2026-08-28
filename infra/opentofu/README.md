# Meshr production foundation

This stack is intentionally single-region and cost-bounded: GKE Autopilot and
regional Firestore in `us-central1`, Pub/Sub ordered event delivery, Artifact
Registry, Identity Platform, Secret Manager, Monitoring, and scoped Cloudflare
DNS records. Crossplane and a permanent staging cluster are out of scope. The
canary uses an independent staging Gateway and static address so real
pre-promotion E2E does not depend on a production route.

Create a dedicated GCS state bucket before the first apply (with Object
Versioning, uniform bucket-level access, and access limited to the launch
operators and CI). Run `tofu init -backend-config="bucket=$STATE_BUCKET"`,
`tofu plan`, and a protected `tofu apply` only from the launch environment; do
not use local state for production. Validation plans intentionally leave
`launch_mode=false` (the default), which keeps provider credentials and billing
optional while checking syntax and dependency shape. The protected public
launch apply must set `launch_mode=true`; OpenTofu then refuses to proceed
unless a real billing account and both Google/GitHub OAuth credential pairs are
present. Supply a real billing account,
`gke_control_plane_authorized_cidrs` with the fixed-egress CIDR(s) of the
operator bastion or self-hosted CI runner, Cloudflare token, project, immutable
 image digest, and both Identity Platform OAuth credentials through a private
variables file. GitHub-hosted runner ranges and `0.0.0.0/0` are deliberately
rejected by policy; configure a fixed-egress runner or use GKE Connect Gateway
for the protected promotion jobs. The stack reserves separate static global
Gateway IPv4 addresses for production and staging. The Google and GitHub
provider resources are omitted when their credentials are null only while
`launch_mode=false`; a public launch must configure both.

DNS records are independently opt-in: leave both
`manage_production_dns_records=false` and `manage_staging_dns_records=false`
while the existing site is live. You can enable and verify the canary first by
setting only `manage_staging_dns_records=true`; import/check the staging record,
Gateway address, certificate, delegation, and Full (strict) TLS before running
the canary E2E. Enable `manage_production_dns_records=true` only during the
approved production cutover window after the root record and production
certificate have been imported and verified. This split prevents a staging
validation apply from changing production traffic. Verify both hostnames before
enabling public traffic.

The cluster enables GKE's managed Secret Manager CSI component. Before the
production Kustomization is reconciled, add a version to both secrets created
by this stack (the API key can be copied from the sensitive Terraform output):

```bash
gcloud secrets versions add meshr-identity-api-key --data-file=identity-api-key.txt
openssl rand -base64 32 | gcloud secrets versions add meshr-internal-token --data-file=-
openssl rand -base64 32 | gcloud secrets versions add meshr-renewal-recovery --data-file=-
gcloud secrets versions add meshr-canary-identity-api-key --data-file=identity-api-key.txt
openssl rand -base64 32 | gcloud secrets versions add meshr-canary-internal-token --data-file=-
openssl rand -base64 32 | gcloud secrets versions add meshr-canary-renewal-recovery --data-file=-
```

Autopilot node VMs use the dedicated `gke_node_service_account_id` identity
(default `meshr-gke-nodes`). OpenTofu grants it the GKE node role and
repository-scoped Artifact Registry read access before the cluster is created,
so private image pulls do not depend on a project default compute account.

The Kubernetes `SecretProviderClass` resources mount these values into the API,
ingest, and live-gateway pods. The renewal-recovery key is mounted only into
the API; it is never available to the live gateway or event workers. A missing version intentionally leaves the pods
unready and the application fails closed rather than starting with a literal
placeholder. Canary mounts and service accounts are separate from production;
its authoritative and aggregate topology Firestore databases and Pub/Sub
topics are isolated, and its datastore IAM grants are conditioned on the
matching database resources. The public live gateway has a viewer grant only
for the aggregate topology database; it cannot read accounts, sessions, posts,
moderation, or audit data.

OpenTofu creates separate keyless GitHub Actions identities for artifact builds,
canary promotion, and production promotion. Set the
`github_actions_workload_identity_provider` and `ci_service_account` outputs as
the protected `GCP_BUILD_WORKLOAD_IDENTITY_PROVIDER` secret and
`GCP_BUILD_SERVICE_ACCOUNT` repository variable. Set
`github_actions_canary_deploy_workload_identity_provider` and
`ci_canary_deploy_service_account` as the protected
`GCP_CANARY_DEPLOY_WORKLOAD_IDENTITY_PROVIDER` secret and
`GCP_CANARY_DEPLOY_SERVICE_ACCOUNT` repository variable in the `canary`
environment. Set `github_actions_deploy_workload_identity_provider` and
`ci_deploy_service_account` as the protected
`GCP_DEPLOY_WORKLOAD_IDENTITY_PROVIDER` secret and
`GCP_DEPLOY_SERVICE_ACCOUNT` repository variable. The deploy providers accept
only this repository's matching environment, `main` ref, and exact workflow
path, and each service account can read GKE or mutate only its own Flux input
ConfigMaps. The build identity can write images but cannot touch the cluster.
Also set `GCP_PROJECT_ID`, `GKE_CLUSTER`, `GKE_LOCATION`, and `MESHR_CANARY_URL`
(for example `https://staging.meshr.social`) as protected variables. The canary
job verifies signatures, updates `meshr-canary-*` ConfigMaps, waits for all
canary rollouts, and probes the canary API/web health endpoints. Only after that
protected gate does production update `meshr-production-*` ConfigMaps and the
auditable digest file; a missing protected variable fails the promotion before a
release can be advertised.

GCP budget thresholds are alerts, not a hard spending cap. Application cost
protection is configured in Kubernetes and the API: at 95% projected spend,
preserve login, reads, owner controls, and moderation while blocking new
sessions and mesh creation before reducing write/fan-out quotas.
