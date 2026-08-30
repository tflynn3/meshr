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
not use local state for production. The Cloudflare API token must have
Zone:Read, DNS:Edit, Zone Settings:Edit, Zone Transform Rules:Edit, and
Account Rulesets:Read; the transform-rule permission is required for the
zone-specific origin header. Validation plans intentionally leave
`launch_mode=false` (the default), which keeps Cloudflare, social-provider, and
billing credentials optional while checking syntax and dependency shape. The
protected public launch apply must set `launch_mode=true`; OpenTofu then refuses
to proceed unless a real billing account, Cloudflare token, and both
Google/GitHub OAuth credential pairs are present. Also supply
`gke_control_plane_authorized_cidrs` with the fixed-egress CIDR(s) of the
operator bastion or self-hosted CI runner, project, and immutable image digest
through a private variables file. GitHub-hosted runner ranges and `0.0.0.0/0`
are deliberately rejected by policy; configure a fixed-egress runner or use
GKE Connect Gateway
for the protected promotion jobs. The stack reserves separate static global
Gateway IPv4 addresses for production and staging. The Google and GitHub
provider resources are omitted when their credentials are null only while
`launch_mode=false`; a public launch must configure both.

The protected launch also requires `accept_worker_authority_database_risk=true`
after the security owner signs the residual worker Firestore boundary in
[`docs/IAM_MATRIX.md`](../../docs/IAM_MATRIX.md). Leave it false until that
review is complete; the guard intentionally prevents an unreviewed public
apply. Because the projection bootstrap marker currently shares that
worker-writable database, the launch additionally requires
`accept_projection_marker_writer_risk=true` until the marker moves to a
separately restricted attestation service/database.

Set `alert_notification_email` for the operations owner on the protected
launch apply. OpenTofu creates one Cloud Monitoring channel and routes the
HTTP, authentication, topology, live-gateway, outbox, durable-store, and
moderation alerts plus the billing budget notifications to it. Dry validation
plans may leave it null. If a restore is cut over, first authorize the restored
Firestore database with `additional_authority_database_names` and provision a
fresh empty topology database through `additional_topology_database_names`;
never restore populated projection collections. Suspend Flux and fence and
quiesce every API and event reader before restoring the authority. Record an
external schema-2 cutover receipt that proves the writer fence happened before
the restore, a fence-bound authority delta was copied with matching
per-collection SHA-256 manifests (sorted collection name, count, and digest),
the bounded source delta was replayed, and the source and
  target outbox high-watermarks agree. Include a unique `receipt_id`, a recent
  `issued_at`, and the writer fence ID. The protected promotion workflow
  verifies and atomically consumes the receipt in the isolated release-audit
  database before switching authorities; an interrupted retry must obtain a
  newly fenced receipt rather than replaying the old one. Only then update the
  protected `MESHR_FIRESTORE_DATABASE` and `MESHR_TOPOLOGY_FIRESTORE_DATABASE`
  runtime values, run the generation-fenced bootstrap Job, attest the marker, and
  roll and resume the workloads. Set the protected
`MESHR_AUDIT_FIRESTORE_DATABASE` value to `meshr-release-audit` for production
and `meshr-canary-release-audit` for canary. Runtime event workers use the
separate `MESHR_EVENT_AUDIT_FIRESTORE_DATABASE` /
`MESHR_NOTIFICATIONS_FIRESTORE_DATABASE` values (`meshr-audit` /
`meshr-notifications`, with matching `meshr-canary-*` names) for delivery
traces and notification outbox state. Release service accounts access only
their dedicated release-audit databases; worker grants are similarly
database-scoped. Firestore IAM conditions are database-scoped, so
application-level immutability is enforced by the audit repository rather
than by a fictional collection-path IAM condition.

The first launch is deliberately a two-phase bootstrap because the moderation
adapter image digests are produced by the protected build job, while the
authenticated Cloud Run services are created by the launch apply:

1. Apply the foundation with `launch_mode=false`, both moderation adapter image
   variables unset, and DNS management disabled. This creates the Artifact
   Registry, WIF identities, cluster, databases, and IAM needed by the build
   and promotion jobs without creating a provider-backed adapter or changing
   public DNS.
2. Configure the protected GitHub variables/secrets from the OpenTofu outputs,
   then dispatch the `Meshr CI` workflow for the exact `main` SHA with
   `bootstrap_build_only=true`. The job still runs the normal verification,
   SBOM/provenance, vulnerability scan, and keyless signing gates, but skips
   canary and production promotion. Copy the four immutable references from
   the build job's `Signed immutable image digests` summary.

   From an authenticated operator workstation, the dispatch is:

   ```bash
   MAIN_SHA="$(git rev-parse origin/main)"
   gh workflow run ci.yml --ref main \
     -f release_sha="$MAIN_SHA" \
     -f bootstrap_build_only=true
   ```
3. Create and verify the Model Armor template, then run the protected
   `launch_mode=true` apply with those signed moderation adapter references and
   `moderation_model_armor_template` (plus OAuth, billing, and the reviewed
   fixed-egress CIDRs). This creates the production and canary Cloud Run
   adapters without a placeholder image or provider configuration.
4. Read the adapter URLs from the outputs, set the canary/production protected
   `MESHR_MODERATION_ENDPOINT`, `MESHR_MODERATION_HEALTHCHECK_URL`, and
   `MESHR_MODERATION_AUDIENCE` values, verify the Gateway/TLS prerequisites,
   and dispatch the normal workflow for the same SHA. It advances the canary
   adapter first, runs the native-session/browser gates, and only then permits
   the explicitly approved production promotion.

Do not skip phase 2 by inventing a digest or by applying a mutable image tag;
the launch guard and CI signature checks intentionally reject that shortcut.

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

Before the first protected apply, inspect the Cloudflare zone for existing
account- or zone-level rulesets. The `cloudflare_ruleset.meshr_origin_auth`
resource assumes complete control of the zone transform phase; use
Cloudflare's `cf-terraforming` ruleset import workflow to import and merge any
existing ruleset, or remove the existing root/zone ruleset during an approved
maintenance window. Do not apply this module over an unmanaged ruleset: the
provider may replace unrelated rules. Record the imported ruleset ID and a
plan with no unexpected deletes before enabling either DNS flag.

Set `cloudflare_origin_secret` to a freshly generated 32-128 character
URL-safe value on every launch or rotation. OpenTofu installs a Cloudflare
zone transform that overwrites `x-meshr-origin-secret` on proxied Meshr
requests, and Cloud Armor rejects requests without the matching value. Keep
the remote GCS state bucket restricted because the transform action contains
the secret; never expose it to browser code, manifests, or logs.

The cluster enables GKE's managed Secret Manager CSI component. Before the
production Kustomization is reconciled, add a version to both secrets created
by this stack (the API key can be copied from the sensitive Terraform output):

```bash
gcloud secrets versions add meshr-identity-api-key --data-file=identity-api-key.txt
openssl rand -base64 32 | gcloud secrets versions add meshr-internal-token --data-file=-
openssl rand -base64 32 | gcloud secrets versions add meshr-renewal-recovery --data-file=-
openssl rand -base64 32 | gcloud secrets versions add meshr-renewal-recovery-previous --data-file=-
openssl rand -base64 32 | gcloud secrets versions add meshr-invitation-pepper --data-file=-
openssl rand -base64 32 | gcloud secrets versions add meshr-invitation-pepper-previous --data-file=-
gcloud secrets versions add meshr-canary-identity-api-key --data-file=identity-api-key.txt
openssl rand -base64 32 | gcloud secrets versions add meshr-canary-internal-token --data-file=-
openssl rand -base64 32 | gcloud secrets versions add meshr-canary-renewal-recovery --data-file=-
openssl rand -base64 32 | gcloud secrets versions add meshr-canary-renewal-recovery-previous --data-file=-
openssl rand -base64 32 | gcloud secrets versions add meshr-canary-invitation-pepper --data-file=-
openssl rand -base64 32 | gcloud secrets versions add meshr-canary-invitation-pepper-previous --data-file=-
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

Rotate the recovery and invitation keys in two complete rollouts because CSI
mounted values and the API keyrings are read once at process start. First write
the new value to each `*-previous` secret while leaving the old value as the
primary, then roll every API replica to the overlapping `{old,new}` keyring.
Only after that rollout is healthy, write the new value as primary (retaining
the old value in `*-previous`) and roll every replica again to `{new,old}`.
Keep the immediately retired primary in the previous slot for the full
renewal/invitation overlap window (at least 30 days) before replacing it. The
API accepts both key slots for deterministic renewal recovery and
role-invitation lookup, while newly issued credentials always use the primary
slot. Do not remove the previous slot during either rolling deploy.

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
Also set `GCP_PROJECT_ID`, `GKE_CLUSTER`, `GKE_LOCATION`, `MESHR_CANARY_URL`
(for example `https://staging.meshr.social`),
`MESHR_FIRESTORE_DATABASE`, `MESHR_AUDIT_FIRESTORE_DATABASE`,
`MESHR_TOPOLOGY_FIRESTORE_DATABASE`,
`MESHR_COST_PROTECTION_OPERATOR`, and `MESHR_COST_PROTECTION_REASON` as
protected variables. The canary
job verifies signatures, updates `meshr-canary-*` ConfigMaps, waits for all
canary rollouts, and probes the canary API/web health endpoints. Only after that
protected gate does production update `meshr-production-*` ConfigMaps and the
auditable digest file; a missing protected variable fails the promotion before a
release can be advertised.

The production and canary overlays also reconcile a one-shot
`*-store-bootstrap` Job using the dedicated `meshr-bootstrap` or
`meshr-bootstrap-canary` Workload Identity service account. It is the only
intended marker writer and the only component that invokes the bootstrap
helper; API replicas receive aggregate read access only. Firestore IAM
conditions are database-scoped, however, so the topology materializer's
database-scoped write grant could technically mutate the marker. Application
code keeps that helper out of materializers and the generation fence makes an
invalid marker or a changed authority generation fail readiness; a
same-generation rewrite is not detectable by this marker alone. Treat
marker-writer exclusivity as an application-enforced boundary until the
attestation is moved to a separately restricted database or custom service.
Keep a separate approved binding state
in `MESHR_CANARY_PROTECTED_STATE_JSON` /
`MESHR_PRODUCTION_PROTECTED_STATE_JSON` (with matching `*_PROTECTED_BINDINGS`)
for non-normal cost-protection smoke so normal native acceptance cannot
supersede the throttle fixture.

Protected-mode CI keeps the current refreshed fixture as an AES-256-GCM
envelope in the dedicated canary or production release-audit Firestore
database. GitHub Actions
`meshr-{canary,production}-protected-fixture-{pre,post}` artifacts contain the
same envelope as bounded evidence only; they are not a recovery fallback or
authority. The raw `state.json` is never uploaded. On a normal-to-protected
transition the refreshed pre-rollout envelope is promoted with a generation
compare-and-set before the runtime mode changes, so the superseded session can
always be recovered; the post-smoke envelope is a separate generation promoted
with a second compare-and-set. Runs that are already protected stage only the
post-smoke generation. If smoke or the workflow fails, the last promoted
pointer remains available for recovery. Set the matching
`MESHR_CANARY_PROTECTED_STATE_KEY` or `MESHR_PRODUCTION_PROTECTED_STATE_KEY`
repository secret to a randomly generated 32-byte key. Rotate it by returning
the environment to `normal`, refreshing the approved secret, changing the key,
and entering protected mode again; old artifacts are intentionally not
decryptable with the new key. A later protected run reads only the current
release-audit pointer and fails closed if an already-protected environment has
no current envelope.

The moderation adapter is a separately deployed, authenticated Cloud Run
workload built from `deploy/images/moderation-adapter.Dockerfile`. CI builds,
scans, attests, and signs its multi-architecture image alongside the API,
event-plane, and web images. Supply the exact signed production digest as
`moderation_adapter_image` and the exact signed canary digest as
`moderation_adapter_canary_image`; keeping these inputs separate lets the
canary job update and verify only the canary service before production is
changed. Both are required by the protected `launch_mode=true` apply. After
the foundation creates the services, the protected CI promotion owns image
revision advancement with a service-scoped `roles/run.developer` grant and
runtime-service-account `roles/iam.serviceAccountUser`. OpenTofu ignores only
the image field and exposes the live digest through
`moderation_adapter_*_deployed_image`, so routine applies cannot roll a
promoted adapter back to stale bootstrap tfvars. The
adapter's dedicated service accounts receive `roles/modelarmor.user` and
`roles/dlp.user`; production/canary event-plane workers receive only
`roles/run.invoker` on their matching adapter service. The adapter calls both
Model Armor and Sensitive Data Protection using short-lived ADC credentials and
exposes bounded authenticated `/screen` and side-effect-free `/healthz` and
`/readyz` endpoints. Set each environment's `MESHR_MODERATION_ENDPOINT` to its
`/screen` URL, `MESHR_MODERATION_HEALTHCHECK_URL` to `/healthz`, and
`MESHR_MODERATION_AUDIENCE` to the matching Cloud Run service URI. Worker pods
never receive provider-level credentials.

GCP budget thresholds are alerts, not a hard spending cap. Application cost
protection is configured in Kubernetes and the API: at 95% projected spend,
preserve login, reads, owner controls, and moderation while blocking new
sessions and mesh creation before reducing write/fan-out quotas.

The moderation-screening-worker HPA also depends on the cluster-scoped GKE external
metrics adapter. Moderation intake publishes a durable screening job after it
records the Firestore inbox row, so this subscription backlog measures actual
provider work rather than an already-acknowledged source event. OpenTofu creates its dedicated Workload Identity service
account and exposes it as `metrics_adapter_service_account`; install the
pinned manifest and create the Flux substitution before reconciling either
application overlay:

```bash
export METRICS_ADAPTER_GSA="$(tofu -chdir=infra/opentofu output -raw metrics_adapter_service_account)"
envsubst < deploy/metrics-adapter/adapter.yaml | kubectl apply -f -
kubectl -n flux-system create configmap meshr-metrics-adapter-values \
  --from-literal=METRICS_ADAPTER_GSA="$METRICS_ADAPTER_GSA" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f deploy/production/flux/metrics-adapter-kustomization.yaml
```

The Flux Kustomization waits for the adapter `APIService`; the production and
canary application Kustomizations declare it in `dependsOn`. Run
`scripts/check-gke-metrics-adapter.sh` for each moderation HPA before approving
promotion.
