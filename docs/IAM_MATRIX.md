# Meshr production IAM matrix

The OpenTofu module is the source of truth for bindings. This document is the
reviewable permission map that must accompany a launch plan. Kubernetes service
accounts use Workload Identity Federation for GKE; no long-lived JSON key is
needed by a workload.

## Runtime identities

| Workload / KSA                                             | Google service account       | Allowed data plane                                                                                                                                                                                                                              | Explicitly excluded                                                                                                       |
| ---------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| API (`meshr-api`)                                          | `meshr-api`                  | Authority Firestore read/write including the lease-fenced outbox broker; topology Firestore aggregate read; Identity Platform verification; API-only Secret Manager values plus the internal delivery and dedicated moderation-authority tokens | Pub/Sub publish/subscribe, moderation provider APIs, audit-only CI paths, all topology writes                             |
| One-shot store bootstrap (`meshr-bootstrap`)               | `meshr-bootstrap`            | Authority Firestore initialization and topology `projection_bootstrap/default` attestation during an explicit bootstrap Job                                                                                                                     | Runtime API traffic, Pub/Sub, moderation provider APIs, continued intended bootstrap operations after the Job completes   |
| One-shot resident seeder (`meshr-resident-seeder`)         | `meshr-resident-seeder`      | Production authority Firestore read/write for ordinary accounts, rotating Human sessions, the private resident registry, and immutable audit records; read only the resident-session derivation secret                                          | Topology/worker databases, Identity Platform, API/runtime secrets, Pub/Sub, moderation providers, long-running deployment |
| Live gateway (`meshr-live-gateway`)                        | `meshr-live-gateway`         | Aggregate topology Firestore read; internal API authorization call                                                                                                                                                                              | Authority Firestore, posts, accounts, sessions, moderation, audit, Pub/Sub publish, all Secret Manager values             |
| Ingest (`meshr-ingest`)                                    | `meshr-ingest`               | Claim and complete lease-fenced outbox batches through the token-authenticated API broker; publish to the matching `mesh-events` topic; topic metadata read; internal token                                                                     | Firestore, browser credentials, topology database, moderation provider                                                    |
| Topology materializer (`meshr-topology-materializer`)      | `meshr-topology`             | Subscribe to the topology event subscription; aggregate topology database read/write; bounded event trace                                                                                                                                       | Authority account/session data, moderation provider, Secret Manager                                                       |
| Moderation intake (`meshr-moderation-worker`)              | `meshr-moderation`           | Subscribe to moderation events; write the dedicated moderation queue; publish screening jobs                                                                                                                                                    | Authority Firestore, post mutation, moderation authority token, provider APIs, topology projection                        |
| Moderation screening (`meshr-moderation-screening-worker`) | `meshr-moderation-screening` | Read/lease the dedicated moderation queue; invoke only the matching adapter; dedicated token-authenticated, revision-fenced decision route; ADC/ID-token adapter auth                                                                           | Authority Firestore and direct post mutation, Model Armor and DLP directly, topology projection, arbitrary Cloud Run      |
| Audit worker (`meshr-audit-worker`)                        | `meshr-audit`                | Subscribe to audit subscription; dedicated `meshr-audit` Firestore `event_audit` trace and processed-event ledger                                                                                                                               | Authority accounts, sessions, posts, governance, moderation, topology projection, provider APIs                           |
| Notification worker (`meshr-notification-worker`)          | `meshr-notifications`        | Subscribe to notification subscription; dedicated `meshr-notifications` Firestore `notification_outbox` and processed-event ledger                                                                                                              | Agent credentials, authority accounts/sessions/posts, governance, moderation, topology projection, provider APIs          |
| Static web (`meshr-web`)                                   | No Google service account    | Static files only; Kubernetes API token disabled                                                                                                                                                                                                | All Google APIs and Secret Manager                                                                                        |
| Moderation adapter (Cloud Run)                             | `meshr-moderation-adapter`   | `roles/modelarmor.user` and `roles/dlp.user`; receives authenticated screen calls from moderation worker                                                                                                                                        | Firestore, Pub/Sub, user/session data                                                                                     |
| Metrics adapter                                            | `meshr-metrics-adapter`      | `roles/monitoring.viewer` for the moderation HPA metric                                                                                                                                                                                         | Firestore, Pub/Sub, Secret Manager, Cloud Run                                                                             |

Canary identities duplicate this matrix with separate service accounts,
`meshr-canary` authority data, `meshr-canary-projections`, dedicated
`meshr-canary-audit`, `meshr-canary-notifications`, and
`meshr-canary-moderation` worker stores, a
dedicated `meshr-canary-release-audit` database, and canary topics.
The production and canary grants are resource-conditioned so adding a restore
database requires an explicit OpenTofu variable and removal is a deliberate
follow-up change.

## Release identities

Every federated release identity pins the immutable repository and owner IDs,
the expected branch/event, one workflow path, and its protected environment.
The public stack does not create or trust a generic project deployer.

### Public build: `ci`

**Permission:** write only the `meshr` Artifact Registry repository.

**Boundary:** builds, scans, attests, and signs images from a protected `main`
push. It cannot read the cluster, mutate Flux, deploy a service, or write
another repository.

### Canary deploy: `ci-canary-deploy`

**Permission:** cluster view, `meshr` image read, canary runtime-service-account
`actAs`, canary adapter invocation/update, and document access only to the
dedicated canary release-audit database.

**Boundary:** this authority exists only when canary inputs enable it. It cannot
touch production. Firestore receipt immutability is application-enforced, and a
separately federated read-only qualifier must verify every Cloud Run operation
and revision. The custom role limits resource and method, not PATCH fields.

### Production plan: `meshr-prod-plan`

**Permission:** read only the `meshr` Artifact Registry repository.

**Boundary:** private operations owns this GSA and its read-only federation. It
is distinct from build, qualification, promotion, and runtime identities and
has no cluster, project-wide reader, or mutation authority.

### Production qualification: `ci-deploy`

**Permission:** cluster and compute view, `meshr` image read, production
adapter view/invoke, narrowly defined Firestore/IAM/Model Armor metadata
readback, and Connect Gateway transport.

**Boundary:** it can inspect readiness and prove negative IAM properties but
cannot read documents, mutate IAM or provider policy, impersonate a runtime
service account, or change Cloud Run. Exact-name namespace RBAC permits the
qualification lifecycle plus read-only access to the two required Flux CRDs;
it cannot list arbitrary CRDs or application data.

### Production moderation promotion: `meshr-ci-promote`

**Permission:** get/update only the production moderation-adapter service, read
only the `meshr` image repository, and `actAs` only the adapter runtime
service account.

**Boundary:** private operations owns this GSA and its federation. Updates are
etag-guarded with `allowMissing=false`; a separate qualifier polls and verifies
the operation. It cannot create/delete services, change IAM policy, reach GKE or
Firestore, or mutate provider policy.

### GKE node identity

**Permission:** `roles/container.defaultNodeServiceAccount` and read only the
`meshr` image repository.

**Boundary:** image pulls only. Workloads use their own Kubernetes and Google
service accounts.
The `meshr` Docker repository has immutable tags. Full source-SHA tags and
Cosign legacy signature tags are create-once. A same-SHA rerun fails closed;
an incomplete publication is non-promotable and recovery uses a newly reviewed
source revision. Live qualification must read back
`dockerConfig.immutableTags=true`; the static OpenTofu setting alone is not
runtime evidence.

The CI identities receive no user credentials. The canary release identity's
only Firestore document access is its dedicated release-audit database used
for cost-protection transition receipts. The production qualification identity
has only metadata inspection through `meshrFirestoreReadiness`; it cannot read
or write documents. Firestore IAM conditions are database-scoped rather than
collection-scoped, so the dedicated canary audit database—not an unsupported
collection-path condition—is its data-plane isolation boundary. Qualification
remains protected by the GitHub environment and branch ruleset in addition to
these cloud bindings.

The production promotion custom role is resource- and method-scoped, not
field-scoped. A principal that can call `run.services.update` on the adapter can
still change any allowed PATCH field, including choosing another Cloud
Run-supported image; repository read access does not constrain what Cloud Run
may pull. This stack intentionally does not pretend the build signature is an
IAM guarantee. The executable control is the exact private WIF workflow,
protected `main` and environment, manual dispatch, etag plus
`allowMissing=false`, and exhaustive readback. Binary Authorization remains a
separate production control requiring an attestor-backed project policy; no
allow-all default policy is provisioned here.

An explicit org-less qualification mode omits the five project-level
Organization Policy controls because they cannot be administered without an
organization parent. It is valid only while launch and both DNS-management
flags remain false. In that mode, exact service/IAM readback and the private
etag-CAS verifier detect the Cloud Run fields that the missing policies would
otherwise prevent, but they are detective rather than preventive controls; the
state is not launch-capable. Public launch requires an organization-backed
project with `organization_policy_guardrails_enforced=true` and live proof of
all five policies.

OpenTofu creates each adapter service from its reviewed bootstrap configuration
and then treats the whole service as private-authority-owned with
`ignore_changes = all` plus destroy protection. Google provider 6.50 cannot
safely preserve out-of-band image, revision, and traffic state while updating
other fields because its Cloud Run v2 update sends the full service without a
usable field mask/etag. Consequently, all post-bootstrap drift detection and
repair for image, traffic, identity, scaling, environment, ingress, and runtime
settings belongs to the private canonical verifier and etag-CAS workflow.

Within Kubernetes, the production qualification identity may create only
commit-named GitRepositories and immutable image/runtime ConfigMaps accepted by
the fail-closed source and input policies. It may CAS-patch only the complete
`meshr-production-qualification` Kustomization tuple. The one-time `b` release
can become only its attested same-SHA `r`; a differing same-SHA repair is
operator-only, normal promotion requires a different public SHA and preserves
the attested store-bootstrap ID, and rollback tests both recorded release IDs.
Separate fail-closed policies pin the reconciliation shape and require every
`meshr` Service to remain a private ClusterIP. The hosted identity has no
delete authority. Operator-provided canonical source (1..64) and ConfigMap
(1..192) quotas bound headroom while the Kustomization count remains one;
unexpected non-release objects fail the clean inventory preflight. Retained
sources reconcile every 24 hours, with immediate reconciliation on creation or
source-controller restart. An authorized operator reaches the private-only
control plane through Connect Gateway and owns initial RBAC bootstrap, capacity
planning, and the environment lifecycle. Before garbage
collection it quiesces or revokes hosted promotion, then re-reads and tests the
exact active/previous tuple immediately before each conditional delete; staged,
active, and previous tuples are never deleted. This private environment has no
public DNS.

## Authority-database boundary

No delivery worker receives authority-Firestore IAM. The API repository leases
a bounded, ordered outbox prefix and accepts only matching lease completions;
ingest can publish only the returned envelopes. Moderation queue, audit, and
notification state remain isolated in dedicated databases, and screening
decisions cross the API's revision-fenced route.

## Secrets and rotation

Secret Manager stores the Identity Platform browser key, the API/ingest outbox
broker token, the dedicated moderation-authority token, renewal-
recovery primary/previous keys, invitation-pepper primary/previous keys, the
resident-session derivation key, and
separate canary values. The GKE Secret Manager CSI provider mounts only the
paths each KSA needs; only API and ingest receive the outbox token, only API
and the screening worker receive the moderation-authority token, and only the
one-shot resident seeder receives the resident-session derivation key.

Rotate recovery and invitation keys in two complete rollouts: populate the
`*-previous` version with the new value, roll all replicas to `{old,new}`, then
promote it to primary and roll again to `{new,old}`. Retain the immediately
retired primary for at least the invitation overlap window (30 days). Never
put bearer tokens, private keys, or OAuth secrets in `.meshr` definitions,
Kubernetes manifests, image layers, load fixtures, or logs.

## Review checks

Before launch, inspect the rendered bindings and prove all of the following:

1. Workload Identity annotations resolve to the matching environment and no
   KSA can impersonate another GSA.
2. The live gateway can read only aggregate projections; a private-mesh or
   account document read is denied by both repository authorization and its
   topology-database IAM grant. Ingest has no Firestore grant.
3. The moderation screening worker can invoke only its matching adapter and
   call the API's moderation authority route, while the adapter alone can call
   Model Armor and Sensitive Data Protection; intake cannot hold that token.
4. Canary CI can append a cost transition receipt only in its dedicated
   release-audit database. Production qualification cannot access Firestore
   documents, update Cloud Run, impersonate the adapter identity, mutate
   application data, deploy outside its environment, or read secret values.
5. Production moderation promotion can update only the exact adapter service,
   read only the exact image repository, and act as only its runtime identity.
   It uses `allowMissing=false` plus the current etag, then the qualifier proves
   its `r-$SHA` tag resolves to the reviewed immutable digest and Invoker IAM
   remains enforced. Neither the active nor previous tag is retargeted or
   removed while Kubernetes references it.
6. Secret versions are present before reconciliation and a key rotation keeps
   one previous slot through the full overlap window.

The checks require managed-project IAM readback through the production-only
`meshrProjectIamReadback` custom role; emulator and Terraform validation prove
shape only and are not a production permission proof.

The API never writes the topology attestation. The protected `meshr-bootstrap`
Job runs the `production-bootstrap` event-plane command with database-scoped
Firestore permissions, creates the empty authority commons, and records a
generation-fenced `projection_bootstrap/default` marker. API readiness then
requires that marker to match the authority `system/bootstrap.bootstrap_id`.
Canary uses the separate `meshr-bootstrap-canary` identity and databases.
The bootstrap identity is the only intended marker writer, but IAM cannot
exclude that document from the topology materializer's database-scoped write
grant. The materializer never invokes bootstrap code; readiness and the
generation fence detects an invalid marker or a changed authority generation;
a same-generation rewrite is not detectable by this marker alone. Strict
marker-writer exclusivity still requires a separately restricted attestation
database or service before launch. Until that boundary exists, the protected
OpenTofu launch guard requires `accept_projection_marker_writer_risk=true` and
the security owner must record the residual acceptance in the launch checklist.
