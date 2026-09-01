# Meshr production foundation

This stack is intentionally single-region and cost-bounded: GKE Autopilot and
regional Firestore in `us-central1`, Pub/Sub ordered event delivery, Artifact
Registry, Identity Platform, Secret Manager, Monitoring, and scoped Cloudflare
DNS records. Crossplane and a permanent staging cluster are out of scope. The
canary uses an independent staging Gateway and static address so real
pre-promotion E2E does not depend on a production route.

GKE is attached to the stack-owned custom-mode `meshr-gke` VPC and regional
subnet; it never inherits a project default network. Nodes and Pods have only
private addresses, Pod and Service secondary ranges are explicit, Private
Google Access is enabled, and outbound traffic crosses Cloud NAT with one
stable address exposed as `gke_nat_ip`. NAT records errors only and VPC flow
logs sample traffic at 0.1, so this is bounded operational telemetry rather
than a complete translation log. The control plane is private-only from its
first apply and has no temporary public-endpoint or CIDR-allowlist state.
Bootstrap and every later CI connection use GKE Connect Gateway.

## Private CI through Connect Gateway

The foundation enables the three APIs required by Google's current Connect
Gateway setup (`connectgateway.googleapis.com`, `gkeconnect.googleapis.com`,
and `gkehub.googleapis.com`) and registers the Autopilot cluster in its own
project's regional fleet. Use `fleet_membership_id` and
`fleet_membership_location` for every credentials request; do not discover a
similarly named membership from another project. The protected apply must set
`connect_gateway_deploy_service_account_email` to the exact existing
production qualification service account created by this stack. A precondition
rejects any other account, and this public stack grants that exact identity only
`roles/gkehub.gatewayAdmin` and `roles/gkehub.viewer` for Gateway transport.
The same identity has read-only `roles/container.clusterViewer` and
`roles/compute.viewer` so the private workflow can inventory the cluster. It
must find only the stack-owned regional external address, router, and Cloud NAT
used for private-node egress, while proving there are no unexpected addresses,
routers, NATs, forwarding rules, backend services, URL maps, instances, or
public ingress resources before and after qualification. It has no Compute
mutation role.
This public stack defines the cloud-side WIF provider, claim condition,
qualification GSA, and impersonation binding. The private operations repository
owns the referenced workflow and protected environment, while its reviewed
apply supplies the immutable repository and owner IDs, `main`, explicit
`workflow_dispatch`, and the exact qualification workflow path that make the
trust executable.

Production moderation revision promotion is deliberately separate. Set the
required `production_moderation_promotion_service_account_email` input to the
exact existing `meshr-ci-promote@PROJECT_ID.iam.gserviceaccount.com` GSA created
by private operations. This public stack does not create that GSA, its WIF
provider, or its impersonation binding. It grants a service-scoped custom role
containing only `run.services.get` and `run.services.update` on the exact
production adapter, repository-scoped `roles/artifactregistry.reader`, and
`roles/iam.serviceAccountUser` on only the adapter runtime service account. A
guard rejects a foreign-project GSA, a different account ID, the read-only
qualifier, or the runtime identity. Private operations must pin its federation
to the immutable private repository and owner IDs, `refs/heads/main`, the exact
promotion workflow, the protected `production` environment, and explicit
`workflow_dispatch`. When `organization_policy_guardrails_enabled=true`, the
enforced `run.managed.requireInvokerIam` project constraint prevents any service
updater from disabling Cloud Run's Invoker IAM check, and
`run.managed.disableInlinedSource` prevents inline-source deployment. Org-less
qualification omits both preventive constraints and instead requires
exhaustive, separately authenticated service readback after every update.
The service-scoped custom role narrows the resource and methods, not the fields
inside an allowed PATCH: its holder could still select another Cloud
Run-supported container image or alter runtime settings. The executable
boundary is therefore the exact private WIF provider, protected `main` and
`production` environment, exact manually dispatched workflow, current etag,
`allowMissing=false`, and exhaustive readback. Build signatures are reviewed
workflow evidence, not an IAM or Binary Authorization guarantee. After an
update returns its long-running operation, the workflow must re-authenticate as
the read-only qualifier to poll and verify it.

The two-stage foundation plan has a separate read-only identity. Set the
required `production_plan_service_account_email` to the existing private-owned
`meshr-prod-plan@PROJECT_ID.iam.gserviceaccount.com` GSA. This public stack
creates neither that GSA nor its workflow-bound WIF trust. The first foundation
apply creates the `meshr` Artifact Registry repository and grants that identity
reader on only that repository. It can then inspect both `linux/amd64` and
`linux/arm64` image configs and the signed build receipt before producing the
second-stage adapter plan. It receives no Cloud Run update, runtime `actAs`,
cluster, Firestore, or project-wide Artifact Registry permission.

Connect Gateway IAM authenticates a request but does not authorize Kubernetes
objects. An explicitly authorized bootstrap operator with project Owner (or
the narrower required service permissions including `roles/container.admin`)
owns the first Connect Gateway session and the initial Kubernetes RBAC. From a
clean checkout at the verified public SHA it creates the `meshr` namespace,
applies the privileged metrics adapter directly, installs the reviewed minimal
Flux controllers, and applies
`deploy/production-qualification/flux-bootstrap.yaml`. Metrics bootstrap is
never delegated to release automation.

The bootstrap manifest binds the exact kustomize-controller ServiceAccount to
only namespaced apply/read/delete access for the resource kinds in the edge-free
overlay. It has no Secret, RBAC, Namespace, or cluster authority. A fail-closed
source policy allows only create-once, commit-named GitRepositories for the
exact public URL, protected `main`, and lowercase full SHA. A second policy
allows only immutable, exact-key image and runtime ConfigMaps named by that
SHA and runtime hash. A third pins the complete Kustomization and permits the
deploy identity to replace the source, image, and runtime references only as
one resource-version-guarded release switch. A fourth policy requires every
qualification Service to remain a private ClusterIP.

The operator initializes one `b` bootstrap tuple. Hosted automation may
finalize it only to the attestation-derived same-SHA `r` tuple; a different
same-SHA repair is operator-only. Later releases switch directly between `r`
tuples for different public SHAs while preserving the original attested store
bootstrap ID. Rollback requires both the expected active and expected previous
IDs. Hosted automation cannot update or delete release objects.
Operator-provided canonical ResourceQuota values bound source (1..64) and
ConfigMap (1..192) headroom while the Kustomization count remains one;
unexpected non-release objects fail the clean inventory preflight. Retained
sources reconcile every 24 hours, with immediate reconciliation on creation or
source-controller restart. Capacity review and the environment lifecycle are
authorized operator operations. Before garbage
collection, the operator quiesces or revokes hosted promotion, then re-reads
and tests the exact active/previous tuple immediately before each conditional
delete; staged, active, and previous tuples are never deleted.

Google's GKE-specific Connect Gateway guide says the Connect agent is no longer
required or installed by default for GKE on Google Cloud. The bootstrap
operator therefore gets the private cluster credential through Connect Gateway
and applies `connect-gateway-rbac.yaml` as direct, exact-User RoleBindings. It
has no mutation-capable ClusterRole, impersonation grant, or
`gke-connect` dependency; the sole cluster-scoped role grants `get` on the two
exact Flux CRDs so the qualifier can reject schema drift. The hosted identity
cannot grant itself any of these
objects. Follow the ordered commands, policy-readiness check, canonical source
and input readback, live Gateway reachability gate, four-policy admission
checks, and private-only boundary in
`deploy/production-qualification/README.md`.

After the one-time bootstrap, the private workflow obtains a Gateway-specific
kubeconfig without contacting the cluster endpoint directly:

```bash
set -euo pipefail
umask 077
export KUBECONFIG="$(mktemp)"
gcloud container fleet memberships get-credentials \
  "$(tofu output -raw fleet_membership_id)" \
  --location "$(tofu output -raw fleet_membership_location)" \
  --project "$PROJECT_ID"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
MEMBERSHIP_ID="$(tofu output -raw fleet_membership_id)"
MEMBERSHIP_LOCATION="$(tofu output -raw fleet_membership_location)"
GATEWAY_SERVER="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
GATEWAY_PATH="/v1/projects/${PROJECT_NUMBER}/locations/${MEMBERSHIP_LOCATION}/gkeMemberships/${MEMBERSHIP_ID}"
case "$GATEWAY_SERVER" in
  "https://connectgateway.googleapis.com${GATEWAY_PATH}" | \
  "https://${MEMBERSHIP_LOCATION}-connectgateway.googleapis.com${GATEWAY_PATH}") ;;
  *) printf 'unexpected Connect Gateway server: %s\n' "$GATEWAY_SERVER" >&2; exit 1 ;;
esac
kubectl auth can-i get deployments -n meshr
kubectl auth can-i get secrets -n meshr | grep -Fx no
kubectl auth can-i create pods/exec -n meshr | grep -Fx no
```

That first Gateway request is a running-system gate, not something Terraform
validation can prove. If the actual cluster reports a Connect-agent
authorization failure and the bootstrap operator observes the exact
`ServiceAccount/gke-connect/connect-agent-sa`, stop and review a narrowly scoped
compatibility binding. Do not create an agent identity or grant cluster-scoped
impersonation automatically.

Google documents `roles/gkehub.gatewayAdmin` as the only predefined role with
the stream permission needed by `kubectl port-forward`; the Kubernetes Role
still limits that stream to `pods/portforward` in `meshr`. Port-forward requires
GKE 1.31 or later and kubectl 1.31 or later; use kubectl 1.32 or later for useful
failure diagnostics. The project has a default quota of ten active Gateway
streams, so qualification automation must bound concurrent tunnels. See the
[Connect Gateway setup](https://cloud.google.com/kubernetes-engine/enterprise/multicluster-management/gateway/setup),
[usage](https://cloud.google.com/kubernetes-engine/enterprise/multicluster-management/gateway/using),
and [GKE fleet registration](https://cloud.google.com/kubernetes-engine/fleet-management/docs/register/gke)
documentation.

Provision production into a dedicated empty project. Private project creation
sets `auto_create_network=false`. In an organization-backed project this stack
defaults `organization_policy_guardrails_enabled=true` and enforces
`compute.skipDefaultNetworkCreation`,
`iam.automaticIamGrantsForDefaultServiceAccounts`, and
`iam.managed.preventPrivilegedBasicRolesForDefaultServiceAccounts` before it
enables Compute, GKE, Cloud Run, or any other managed application API. It also
enforces `run.managed.requireInvokerIam` and
`run.managed.disableInlinedSource` before enabling those APIs. A dedicated
project without an organization parent may set the flag false only for a
non-public qualification with `launch_mode=false` and both DNS-management
flags false. That mode omits the Organization Policy API and all five policies;
it is not eligible for public launch or DNS management. The first plan and
every qualification run must still prove there is no `default`
VPC, that `meshr-gke` is the only VPC, that the cluster/subnet/router/NAT use its
exact self-link, that no default service account has Owner or Editor, and that
GKE uses the dedicated `meshr-gke-nodes` identity. The skip-default-network
constraint must be in force at project creation for a launch-capable project;
an org-less qualification relies on `auto_create_network=false` plus the same
live inventory/IAM proof. Abort if the selected project already contains a
default network or unrelated resources.

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
to proceed unless Organization Policy guardrails are enabled and a real billing
account, Cloudflare token, and both Google/GitHub OAuth credential pairs are
present. The same guard applies to either DNS-management flag. Supply the
project and immutable image digest through a private variables file. The first
apply creates the cluster with
`privateClusterConfig.enablePrivateEndpoint=true`; there is no public-endpoint
bootstrap value or follow-up sealing apply. An authorized project operator gets
the first kubeconfig through Connect Gateway, verifies the exact server path,
applies the narrow deploy RBAC, and proves positive and negative permissions
before handing off to protected automation. All subsequent protected promotion
jobs also use GKE Connect Gateway. The stack reserves
separate static global Gateway IPv4 addresses for production and staging. The
Google and GitHub provider resources are omitted when their credentials are
null only while `launch_mode=false`; a public launch must configure both.

The ingest publisher has no Firestore grant; it leases bounded outbox batches
through the API's token-authenticated repository boundary. Because the
projection bootstrap marker currently shares that
worker-writable database, the launch additionally requires
`accept_projection_marker_writer_risk=true` until the marker moves to a
separately restricted attestation service/database.

Set `alert_notification_email` for the operations owner on the protected
launch apply. OpenTofu creates one Cloud Monitoring channel and routes the
HTTP, authentication, topology, live-gateway, outbox delivery, outbox
heartbeat/stall, durable-store, and moderation alerts plus the billing budget
notifications to it. Dry validation plans may leave it null. If a restore is
cut over, first authorize the restored
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
`meshr-notifications`, with matching `meshr-canary-*` names) and
`MESHR_MODERATION_FIRESTORE_DATABASE` (`meshr-moderation`, with
`meshr-canary-moderation` for canary) for worker-owned state. Release service
accounts access only
their dedicated release-audit databases; worker grants are similarly
database-scoped. Firestore IAM conditions are database-scoped, so
application-level immutability is enforced by the audit repository rather
than by a fictional collection-path IAM condition.

The production and canary authority databases also enable Firestore TTL on
the lifecycle-specific timestamp fields used by `human_sessions`
(`absolute_expires_at_ttl`), `webmcp_grants` and `webmcp_authority`
(`expires_at_ttl`), inactive `runtime_sessions` (`inactive_expires_at_ttl`),
and revoked `agent_bindings` (`revoked_at_ttl`). The repository clears or
delays these markers while credentials remain recoverable, so TTL is cleanup
rather than an authorization decision. After every apply, read back each field
policy in every managed database and wait for its state to become `ACTIVE`;
emulator tests prove marker semantics but cannot prove managed Firestore
deletion.

Run the checked-in, read-only managed-resource comparator after the apply:

```bash
set -euo pipefail
npm run check:firestore-readiness -- \
  --project "$PROJECT_ID" \
  --location "$GCP_REGION"
```

It derives the exact database settings, daily backup schedules, composite
indexes, and TTL manifest directly from `main.tf`, then asks `gcloud` for
bounded JSON projections. The expected location is explicit because
`location_id = var.region` can be overridden at apply time. The check fails on
an absent database; location, PITR, delete-protection, or database-type drift;
a missing, duplicate, or unexpected backup schedule; a missing or extra
index/TTL policy; a composite index that is not `READY`; or a TTL policy that
is not `ACTIVE`. Missing or ambiguous managed-resource fields and empty
inventories fail closed.
The collector addresses only those declared database IDs; unrelated
pre-existing databases in the project remain out of scope and do not create a
false qualification failure.

The protected production qualification identity receives the custom
`meshrFirestoreReadiness` role for this readback. It contains only
database-metadata-get, backup-schedule-list, and index-get/list permissions;
those index permissions also cover TTL metadata. It grants neither Firestore
document reads nor any control-plane mutation.

Private production qualification also receives the custom
`meshrProjectIamReadback` role in the managed project. Its permissions are
exactly `artifactregistry.repositories.getIamPolicy`, `iam.roles.get`,
`iam.serviceAccountKeys.list`,
`iam.serviceAccounts.getIamPolicy`, `iam.serviceAccounts.list`,
`iam.workloadIdentityPoolProviders.get`,
`iam.workloadIdentityPoolProviders.list`, `resourcemanager.projects.get`, and
`resourcemanager.projects.getIamPolicy`. This lets the workflow enumerate every
project service account, prove that none has a user-managed key or a primitive
project role, compare the three narrow custom-role definitions, inventory every
public and private deployment pool to exclude unexpected providers, inspect
each named provider, verify the exact Artifact Registry grant and the deploy,
plan, and promoter service accounts' workload-identity bindings, and compare
project bindings without identity impersonation, primitive Viewer, or IAM
mutation.

The stack owns one retained regional `meshr-moderation` Model Armor template.
Its policy enables prompt-injection/jailbreak, malicious-URI, basic Sensitive
Data Protection, and all four Responsible AI filters at `MEDIUM_AND_ABOVE`;
multi-language detection and `INSPECT_AND_BLOCK` are explicit, partial detector
failures are not ignored, template-operation logging is enabled, and full
sanitize payload logging is disabled. `moderation_model_armor_policy_sha256`
fingerprints these configured controls. Google provider 6.50 does not expose a
detector-model version pin, so qualification must also compare the live fields
and adversarial evaluation remains the behavioral gate. The qualifier's custom
`meshrModelArmorReadiness` role contains only
`modelarmor.templates.get`—never template mutation or sanitize authority. The
`meshr_policy_schema` label and policy fingerprint version Meshr's declared
configuration only; they do not claim to pin Google's detector. Qualification
must record the live filter selector and compare it with the reviewed `Stable`
alias baseline (`v3`). The read-only template GET does not expose which detector
build Google resolves that alias to at runtime, so the receipt must not claim a
resolved detector version. Regional template and DLP endpoint/parent
configuration establish the declared residency boundary; adversarial evaluation
remains the behavioral gate.

Private production qualification is deliberately a staged bootstrap because
the moderation adapter digest is produced by the protected build job, while
OpenTofu creates the authenticated Cloud Run service once and the private
etag-CAS workflow owns every later change:

1. Apply the foundation with `launch_mode=false`, both moderation adapter image
   variables and both matching source-SHA variables unset, and DNS management
   disabled. Keep `organization_policy_guardrails_enabled=true` for an
   organization-backed project. A dedicated org-less qualification project may
   explicitly set it false; retain the resulting
   `organization_policy_guardrails_enforced=false` output in the qualification
   contract and never use that state for launch or DNS. This creates the
   Artifact Registry, public-build and production-
   qualification WIF identities, cluster, databases, managed Model Armor
   policy, and their IAM without creating an adapter, canary-promotion
   authority, or public DNS. Each digest/source-SHA pair must later be supplied
   or omitted together.
2. Configure the protected public build variables/secrets from the OpenTofu
   outputs, then use the successful `Meshr CI` image-build receipt whose
   `source.sha` and `build.workflowSha` both equal the exact public `main` SHA.
   Public CI has no canary or
   production promotion inputs or jobs. The managed image build runs only on
   a push to `main`; manual dispatch performs verification but cannot publish
   images. Before any build or push, the authenticated job verifies immutable
   tags are enabled and all four source-SHA tags are absent.
   Any complete or partial prior publication therefore fails closed instead of
   overwriting or completing the tag set; recovery requires a newly reviewed
   source revision. A failed or partial publication produces no promotable
   receipt, and the receipt records the exact successful run attempt. The job
   verifies exact-version gcloud and Cosign downloads against pinned SHA-256
   values before its first cloud authentication.

   The `meshr` Docker repository enforces immutable tags. Verify the live
   setting before trusting a receipt:

   ```bash
   gcloud artifacts repositories describe meshr \
     --project="$GCP_PROJECT_ID" \
     --location=us-central1 \
     --format=json |
     jq -e '.format == "DOCKER" and .dockerConfig.immutableTags == true'
   ```

   Full 40-character source-SHA tags and Cosign's legacy signature tags are
   create-once. Re-signing or rerunning a published SHA fails closed. Recovery
   from an incomplete publication requires a newly reviewed source revision;
   never promote a partial run or reconstruct its missing receipt. Copy the
   four immutable references from the successful build receipt.

3. Verify the production adapter reference before it enters the reviewed
   variables file. The expected Fulcio identity is the protected public build
   workflow on `main`:

   ```bash
   cosign verify "$MODERATION_ADAPTER_IMAGE" \
     --certificate-identity='https://github.com/tflynn3/meshr/.github/workflows/ci.yml@refs/heads/main' \
     --certificate-github-workflow-sha="$MAIN_SHA" \
     --certificate-github-workflow-trigger='push' \
     --certificate-oidc-issuer='https://token.actions.githubusercontent.com'
   ```

   The exact release witness is baked into the signed image, not supplied as a
   mutable Cloud Run environment override. Verify both supported platform
   configs before the foundation apply:

   ```bash
   for platform in linux/amd64 linux/arm64; do
     crane config --platform "$platform" "$MODERATION_ADAPTER_IMAGE" |
       jq -e --arg sha "$MAIN_SHA" '
         .config.Labels["org.opencontainers.image.revision"] == $sha and
         any(.config.Env[]?; . == ("MESHR_MODERATION_RELEASE_SHA=" + $sha))
       '
   done
   ```

4. Verify the plan contains the exact retained Model Armor policy and its
   expected fingerprint, then apply the following private-only shape. The exact
   reviewed digest and configuration bootstrap the service. Google provider
   6.50 sends full Cloud Run service updates without a safe field mask/etag, so
   both adapter services become create-only OpenTofu resources after that first
   apply. The private etag-CAS workflow owns every mutable service field, and
   its canonical verifier—not a later OpenTofu plan—detects configuration
   drift.

   ```hcl
   launch_mode = false
   # False is allowed only for an org-less, non-public qualification.
   organization_policy_guardrails_enabled = false
   private_moderation_adapter_mode = true
   manage_production_dns_records = false
   manage_staging_dns_records = false

   cloudflare_api_token       = null
   cloudflare_origin_secret   = null
   google_oauth_client_id     = null
   google_oauth_client_secret = null
   github_oauth_client_id     = null
   github_oauth_client_secret = null

   moderation_adapter_image        = "us-central1-docker.pkg.dev/PROJECT_ID/meshr/moderation-adapter@sha256:REPLACE_WITH_VERIFIED_DIGEST"
   moderation_adapter_source_sha   = "REPLACE_WITH_EXACT_40_CHARACTER_PUBLIC_MAIN_SHA"
   moderation_adapter_canary_image = null
   moderation_adapter_canary_source_sha = null
   github_deploy_identity = null

   production_plan_service_account_email                 = "meshr-prod-plan@PROJECT_ID.iam.gserviceaccount.com"
   production_moderation_promotion_service_account_email = "meshr-ci-promote@PROJECT_ID.iam.gserviceaccount.com"
   ```

   The guard rejects a digest outside this project's regional `meshr` registry,
   a canary image, or any DNS, Cloudflare, OAuth, or public-launch input. The
   adapter receives the stack-owned template name directly. The service allows
   no anonymous principal, scales from zero to at most three instances, and
   exposes only an IAM-authenticated Cloud Run URL.

5. Read `moderation_adapter_service_name`,
   `moderation_adapter_service_account`, `moderation_adapter_initial_revision`,
   `moderation_adapter_initial_revision_tag`, and `moderation_adapter_url`. The
   first apply creates exactly
   `meshr-moderation-adapter-r-<first-20-source-SHA>` and assigns 100 percent of
   traffic plus tag `r-<first-20-source-SHA>` to it. This is the initial active
   revision, so a private promotion must not stage a duplicate revision for the
   same SHA. Later promotions stage the reviewed digest as a no-traffic
   revision, bind its deterministic tag without retargeting any active or
   previous tag, and hand the tagged `/screen` and `/healthz` URLs to the
   Kubernetes release transaction. The ID-token audience remains the stable
   `moderation_adapter_url`. Qualification switches to the separate read-only
   identity to verify and invoke the revision; it cannot update Cloud Run,
   impersonate the runtime identity, or access Firestore documents.

For a later public launch, use an organization-backed project, set
`organization_policy_guardrails_enabled=true`, disable
`private_moderation_adapter_mode`, set `launch_mode=true`, and supply the
independently signed canary adapter plus the documented OAuth, billing, and edge
inputs. Verify the output is true and all five policies are enforced before any
DNS management. Continue to use the
distinct private-owned production promotion GSA; never broaden the read-only
qualification identity for that purpose.

Do not skip the build/signature stage by inventing a digest or applying a
mutable image tag. OpenTofu validates immutable shape and registry ownership;
the operator's `cosign verify` supplies the signature evidence that HCL cannot
derive by itself.

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

Before planning or applying an edge change, compare the checked-in Cloud Armor
allowlist with Cloudflare's official IPv4 and IPv6 endpoints:

```bash
set -euo pipefail
npm run check:cloudflare-ranges
```

This check uses only Cloudflare's public plaintext range feeds and prints no
credentials. It also verifies that the bounded primary/secondary Cloud Armor
rule lists exactly reproduce the canonical checked-in IPv4 set.

Set `cloudflare_origin_secret` to a freshly generated 32-128 character
URL-safe value on every launch or rotation. OpenTofu installs a Cloudflare
zone transform that overwrites `x-meshr-origin-secret` on proxied Meshr
requests, and Cloud Armor rejects requests without the matching value. Keep
the remote GCS state bucket restricted because the transform action contains
the secret; never expose it to browser code, manifests, or logs.

The production and canary overlays set
`MESHR_TRUST_CLOUDFLARE_CONNECTING_IP=1`, which makes API and live-gateway
source limits use the validated `CF-Connecting-IP` address. This setting is
safe only behind the matching default-deny Cloud Armor policy, Cloudflare
source ranges, and origin-secret check above. Never enable it for a directly
reachable origin: a direct client could otherwise choose the apparent source
address used by application-level rate limits. Verify the backend rejects a
request without the origin secret before relying on the forwarded address.

The cluster enables GKE's managed Secret Manager CSI component. Before the
production Kustomization is reconciled, add versions to the secrets created by
this stack (the API key can be copied from the sensitive Terraform output):

```bash
set -euo pipefail
gcloud secrets versions add meshr-identity-api-key --data-file=identity-api-key.txt
openssl rand -base64 32 | gcloud secrets versions add meshr-internal-token --data-file=-
openssl rand -base64 32 | gcloud secrets versions add meshr-moderation-authority-token --data-file=-
openssl rand -base64 32 | gcloud secrets versions add meshr-renewal-recovery --data-file=-
openssl rand -base64 32 | gcloud secrets versions add meshr-renewal-recovery-previous --data-file=-
openssl rand -base64 32 | gcloud secrets versions add meshr-invitation-pepper --data-file=-
openssl rand -base64 32 | gcloud secrets versions add meshr-invitation-pepper-previous --data-file=-
gcloud secrets versions add meshr-canary-identity-api-key --data-file=identity-api-key.txt
openssl rand -base64 32 | gcloud secrets versions add meshr-canary-internal-token --data-file=-
openssl rand -base64 32 | gcloud secrets versions add meshr-canary-moderation-authority-token --data-file=-
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
ingest, and moderation screening pods. The general internal token is mounted
only into ingest; the dedicated moderation-authority token is mounted only
into API and screening. The renewal-recovery key is mounted only into the API;
it is never available to the live gateway or event workers. A missing version intentionally leaves the pods
unready and the application fails closed rather than starting with a literal
placeholder. Canary mounts and service accounts are separate from production;
its authoritative, moderation-queue, and aggregate topology Firestore databases and Pub/Sub
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

OpenTofu always creates separate keyless GitHub Actions identities for artifact
builds and production qualification, and creates the distinct canary-promotion
identity only when `launch_mode` or a canary adapter digest/source pair enables
canary. Set `github_repository`,
`github_repository_id`, and `github_repository_owner_id` to the canonical source
repository before applying; all three are required. The numeric IDs are the
immutable federation boundary, while `github_build_workflow_path` completes the
exact workflow-ref claim. Deploy authority never falls back to that public
repository. The build provider also requires GitHub's `public` visibility claim
and a `push` event, matching the only workflow path that can publish images.
Every plan must supply `github_production_deploy_identity` for one
exact private qualification workflow. Foundation and production-adapter-only
plans set `github_deploy_identity = null` and create no canary WIF provider,
canary deploy GSA, custom promotion role, or associated IAM. A launch or canary-
adapter plan must instead supply one exact private canary workflow; its guard
requires that deploy repository ID to differ from the public build repository.
The IDs for an accessible repository are available from GitHub's API (the
caller must be authenticated to read a private operations repository):

```bash
set -euo pipefail
gh api repos/OWNER/REPOSITORY \
  --jq '{repository_id: (.id | tostring), repository_owner_id: (.owner.id | tostring)}'
```

When canary authority is enabled, provide the private canary workflow's full
identity:

```hcl
github_deploy_identity = {
  repository          = "OWNER/meshr-ops"
  repository_id       = "IMMUTABLE_NUMERIC_REPOSITORY_ID"
  repository_owner_id = "IMMUTABLE_NUMERIC_OWNER_ID"
  workflow_path       = ".github/workflows/promote-canary.yml"
}
```

Every protected production stack must separately supply its private
qualification identity. Numeric IDs and the workflow path intentionally have
no defaults; the hosted Meshr instance uses:

```hcl
github_production_deploy_identity = {
  repository          = "tflynn3/meshr-ops"
  repository_id       = "IMMUTABLE_NUMERIC_REPOSITORY_ID"
  repository_owner_id = "IMMUTABLE_NUMERIC_OWNER_ID"
  workflow_path       = ".github/workflows/qualify-production.yml"
}
```

The qualification and canary providers accept only the configured private
repository's immutable IDs, GitHub's `private` repository-visibility claim,
their exact workflow, `refs/heads/main`, explicit `workflow_dispatch`, and the
matching protected `production` or `canary` environment. Qualification checks
the public build evidence but does not promote Cloud Run revisions or write
release-audit documents. Supply two separately provisioned private GSAs through
`production_plan_service_account_email` and
`production_moderation_promotion_service_account_email`; private operations
must bind each to its own exact protected workflow and keep those WIF trusts
out of this public stack.

Set `github_actions_workload_identity_provider` and `ci_service_account` as the
public build workflow's protected `GCP_BUILD_WORKLOAD_IDENTITY_PROVIDER` secret
and `GCP_BUILD_SERVICE_ACCOUNT` repository variable. When non-null, store
`github_actions_canary_deploy_workload_identity_provider` and
`ci_canary_deploy_service_account` only in the private operations repository's
protected `canary` environment. Both outputs are null when canary authority is
disabled. Store
`github_actions_deploy_workload_identity_provider` and
`ci_deploy_service_account` only in its protected `production` environment; the
output names form the private deployment contract. Build, canary, and
qualification use different pool attributes, so a qualification token cannot
inherit Artifact Registry writer or canary mutation authority. The public
workflow has no canary, staging, production, or rollback credentials or jobs.
The promotion GSA has no public WIF-provider output because its executable
federation remains private-owned; verify the
`production_moderation_promotion_service_account`,
`production_plan_service_account`,
`moderation_adapter_service_name`, and `moderation_adapter_service_account`
outputs against the protected private configuration before promotion.
The production qualifier can read GKE and patch only its exact
namespace-scoped qualification release pointer through Kubernetes RBAC. It may
create only admission-approved, retained commit sources and immutable input
maps; it cannot update or delete them. It receives no Firestore document,
Cloud Run update, or service-account impersonation grant.
It also receives the nine-permission `meshrProjectIamReadback` role for exact
project, Artifact Registry policy, custom-role, every WIF provider, all three
release service-account policies, complete service-account inventory, and
user-managed-key absence verification.
The build identity can write images but cannot touch the cluster.
The private operations environments also own their project, cluster, immutable
release tuple, adapter tag URL, Firestore database, and cost-protection inputs.
The private canary workflow verifies the public build receipt, updates the
canary release tuple, waits for all rollouts, and probes the tagged adapter and
private application health endpoints. The private production workflow retains
commit-named inputs and atomically moves its qualification pointer; a missing
protected variable fails before a release can be advertised.

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
`moderation_adapter_image`. With `private_moderation_adapter_mode=true`, a
reviewed OpenTofu plan creates the production service while the public edge,
social providers, and canary adapter remain absent. OpenTofu prevents destroy
but ignores subsequent changes to the whole Cloud Run service; it must never
issue an update that races or overwrites private promotion. The protected
private etag-CAS workflow and exhaustive canonical readback own all later image,
revision, traffic, identity, scaling, environment, network, ingress, and runtime
configuration changes for both production and canary.
The adapter consumes the retained stack-owned Model Armor template directly;
neither a caller-supplied template name nor an out-of-band policy is accepted.
Supply the independently signed canary digest as
`moderation_adapter_canary_image` only for public launch; the private canary
workflow then owns canary revision advancement with the same service-scoped
get/update-only custom-role shape and exact runtime-service-account
`roles/iam.serviceAccountUser`. The separately federated read-only qualifier
polls and exhaustively verifies the resulting operation and revision. Canary
uses `r-<first-14-source-SHA>` because the longer service name otherwise exceeds
Cloud Run's tagged-hostname DNS-label budget; production uses the first 20.
Private production
promotion instead uses only the exact custom service get/update role,
repository-scoped image read, and runtime act-as through the distinct
externally created GSA supplied by
`production_moderation_promotion_service_account_email`; it has no create,
delete, IAM-policy, SSH, job, execution, or instance permission. The private
workflow must send a direct Cloud Run v2 service PATCH with `allowMissing=false`
and the just-read service etag to create the revision without traffic, then
re-authenticate as the qualifier to poll and inspect it. It adds the
deterministic `r-$SHA` tag in a separate etag-guarded service update and proves
the tag targets the expected immutable digest. It must never retarget or remove
an active or previous tag while a Kubernetes release tuple references it. Both
services scale from zero to an explicit maximum of three instances. Their live
digests are exposed through
`moderation_adapter_*_deployed_image`. The
adapter's dedicated service accounts receive `roles/modelarmor.user` and
`roles/dlp.user`; production/canary event-plane workers receive only
`roles/run.invoker` on their matching adapter service. The adapter calls both
Model Armor and Sensitive Data Protection using short-lived ADC credentials and
exposes bounded authenticated `/screen` and side-effect-free `/healthz` and
`/readyz` endpoints. For production, set `MESHR_MODERATION_ENDPOINT` and
`MESHR_MODERATION_HEALTHCHECK_URL` from the same immutable tagged revision URL,
while `MESHR_MODERATION_AUDIENCE` remains the stable Cloud Run service URI.
Canary uses its independently verified environment-specific values. Worker
pods never receive provider-level credentials.

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
set -euo pipefail
export METRICS_ADAPTER_GSA="$(tofu -chdir=infra/opentofu output -raw metrics_adapter_service_account)"
rendered_metrics_adapter="$(mktemp)"
envsubst '${METRICS_ADAPTER_GSA}' \
  < deploy/metrics-adapter/adapter.yaml >"$rendered_metrics_adapter"
! grep -F '${' "$rendered_metrics_adapter"
kubectl apply -f "$rendered_metrics_adapter"
kubectl -n flux-system create configmap meshr-metrics-adapter-values \
  --from-literal=METRICS_ADAPTER_GSA="$METRICS_ADAPTER_GSA" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f deploy/production/flux/metrics-adapter-kustomization.yaml
```

The Flux Kustomization waits for the adapter `APIService`; the production and
canary application Kustomizations declare it in `dependsOn`. Run
`scripts/check-gke-metrics-adapter.sh` for each moderation HPA before approving
promotion.

## Operator-owned environment lifecycle

Hosted qualification cannot delete immutable release inputs or infrastructure.
Do not create public production or staging DNS for private qualification.
Budgets are alerts rather than spend caps, so the operator must review billing,
cost-protection evidence, and release-quota headroom for as long as the
environment runs. The operator may retain it, garbage-collect eligible release
objects, or start an approved teardown. Garbage collection first quiesces or
revokes hosted promotion and then re-reads and tests the exact Kustomization
active/previous tuple immediately before each conditional delete; it never
deletes staged, active, or previous tuples.

Teardown is a later, separately authorized production operation. Before it,
record an immutable receipt containing the human approval reference, exact
project ID and number, remote-state object generation, current public commit,
the SHA-256 of the reviewed destroy plan, live resource inventory, and the IDs
and retention expiry of backups that must survive. If an edge has ever been
enabled, remove DNS/routing first and prove it is no longer serving; disable
promotion identities and workflows; then confirm the required Firestore data
has a restorable backup outside the destroy set.

Deletion protection is deliberately checked in for the cluster and every
Firestore database. A naive destroy must fail. Use a reviewed, single-purpose
change to disable only those protections, apply that change from the protected
environment, produce a fresh full destroy plan, and compare its exact project
and resource set with the receipt before obtaining final approval. Abort on
any additional project or resource. After the approved destroy, retain the
remote-state history and teardown receipt, and independently verify the
project inventory and billing surface are empty. This sequence must remain
manual; do not weaken the default protection values for convenience.
