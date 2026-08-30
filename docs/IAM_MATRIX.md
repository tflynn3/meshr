# Meshr production IAM matrix

The OpenTofu module is the source of truth for bindings. This document is the
reviewable permission map that must accompany a launch plan. Kubernetes service
accounts use Workload Identity Federation for GKE; no long-lived JSON key is
needed by a workload.

## Runtime identities

| Workload / KSA | Google service account | Allowed data plane | Explicitly excluded |
| --- | --- | --- | --- |
| API (`meshr-api`) | `meshr-api` | Authority Firestore read/write; topology Firestore aggregate read; Identity Platform verification; API-only Secret Manager values plus the dedicated moderation-authority token | Pub/Sub publish/subscribe, moderation provider APIs, audit-only CI paths, all topology writes |
| One-shot store bootstrap (`meshr-bootstrap`) | `meshr-bootstrap` | Authority Firestore initialization and topology `projection_bootstrap/default` attestation during an explicit bootstrap Job | Runtime API traffic, Pub/Sub, moderation provider APIs, continued intended bootstrap operations after the Job completes |
| Live gateway (`meshr-live-gateway`) | `meshr-live-gateway` | Aggregate topology Firestore read; internal API authorization call | Authority Firestore, posts, accounts, sessions, moderation, audit, Pub/Sub publish, all Secret Manager values |
| Ingest (`meshr-ingest`) | `meshr-ingest` | Authority Firestore outbox read/update; publish to the matching `mesh-events` topic; topic metadata read; internal token | Browser credentials, topology database, moderation provider |
| Topology materializer (`meshr-topology-materializer`) | `meshr-topology` | Subscribe to the topology event subscription; aggregate topology database read/write; bounded event trace | Authority account/session data, moderation provider, Secret Manager |
| Moderation intake (`meshr-moderation-worker`) | `meshr-moderation` | Subscribe to moderation events; write the dedicated moderation queue; publish screening jobs | Authority Firestore, post mutation, moderation authority token, provider APIs, topology projection |
| Moderation screening (`meshr-moderation-screening-worker`) | `meshr-moderation-screening` | Read/lease the dedicated moderation queue; invoke only the matching adapter; dedicated token-authenticated, revision-fenced decision route; ADC/ID-token adapter auth | Authority Firestore and direct post mutation, Model Armor and DLP directly, topology projection, arbitrary Cloud Run |
| Audit worker (`meshr-audit-worker`) | `meshr-audit` | Subscribe to audit subscription; dedicated `meshr-audit` Firestore `event_audit` trace and processed-event ledger | Authority accounts, sessions, posts, governance, moderation, topology projection, provider APIs |
| Notification worker (`meshr-notification-worker`) | `meshr-notifications` | Subscribe to notification subscription; dedicated `meshr-notifications` Firestore `notification_outbox` and processed-event ledger | Agent credentials, authority accounts/sessions/posts, governance, moderation, topology projection, provider APIs |
| Static web (`meshr-web`) | No Google service account | Static files only; Kubernetes API token disabled | All Google APIs and Secret Manager |
| Moderation adapter (Cloud Run) | `meshr-moderation-adapter` | `roles/modelarmor.user` and `roles/dlp.user`; receives authenticated screen calls from moderation worker | Firestore, Pub/Sub, user/session data |
| Metrics adapter | `meshr-metrics-adapter` | `roles/monitoring.viewer` for the moderation HPA metric | Firestore, Pub/Sub, Secret Manager, Cloud Run |

Canary identities duplicate this matrix with separate service accounts,
`meshr-canary` authority data, `meshr-canary-projections`, dedicated
`meshr-canary-audit`, `meshr-canary-notifications`, and
`meshr-canary-moderation` worker stores, a
dedicated `meshr-canary-release-audit` database, and canary topics.
The production and canary grants are resource-conditioned so adding a restore
database requires an explicit OpenTofu variable and removal is a deliberate
follow-up change.

## Release identities

| Identity | Permissions | Boundary |
| --- | --- | --- |
| Build WIF / `ci` | Artifact Registry writer | Builds, scans, attests, and signs images; cannot read the cluster or mutate Flux |
| Canary deploy WIF / `ci-canary-deploy` | Cluster viewer, Artifact Registry reader, Cloud Run viewer/developer/invoker for the canary adapter, database-scoped `roles/datastore.user` on the dedicated `meshr-canary-release-audit` database | Claim condition is this repository, `main`, the protected workflow path, and `canary` release attribute; cannot touch production adapter or ConfigMap. The predefined role also permits read/update/delete in that database, so receipt immutability is application-enforced. |
| Production deploy WIF / `ci-deploy` | Cluster viewer, Artifact Registry reader, Cloud Run viewer/developer/invoker for the production adapter, database-scoped `roles/datastore.user` on the dedicated `meshr-release-audit` database | Claim condition is this repository, `main`, the protected workflow path, and `production` release attribute; cannot touch canary adapter or arbitrary application data. The predefined role also permits read/update/delete in that database, so receipt immutability is application-enforced. |
| GKE node identity | `roles/container.defaultNodeServiceAccount` and repository-scoped Artifact Registry reader | Image pulls only; workloads use their own KSAs |

The CI release identities receive no user credentials. Their only Firestore
access is the dedicated release-audit database used for cost-protection
transition receipts. Firestore IAM conditions are database-scoped rather
than collection-scoped, so the dedicated database—not an unsupported
collection-path condition—is the isolation boundary. Promotion remains
protected by the GitHub environment and branch ruleset in addition to these
cloud bindings.

## Residual authority-database boundary

The ingest service still requires the production authority database for outbox
publication and remains database-scoped because Firestore predefined roles
cannot express a collection/document-path IAM condition. Moderation inbox
leases and dead letters now live in the dedicated moderation database, and the
screening worker has no authority-database grant; all post/case decisions cross
the API's revision-fenced route. Audit and notification workers remain isolated
in their dedicated databases.

### Launch security acceptance

The ingest service requires authority Firestore access for outbox publication;
Google predefined roles cannot express a collection/document-path IAM
condition, so that grant remains database-scoped. Moderation queue leases and
dead letters are isolated in their own database, while screening decisions
cross the narrow internal authority route and are revision-fenced in the API
transaction. Audit and notification state are separate databases as well.

`accept_worker_authority_database_risk` must be set explicitly for a protected
OpenTofu launch. That acceptance records the remaining ingest boundary and
requires the following compensating controls: distinct workload identities
and namespaced NetworkPolicies, repository authorization tests for every worker
operation, immutable event IDs and audit history, no user credentials in
workers, and monitoring/alerting for unexpected collection access.

## Secrets and rotation

Secret Manager stores the Identity Platform browser key, the ingest-only
internal service token, the dedicated moderation-authority token, renewal-
recovery primary/previous keys, invitation-pepper primary/previous keys, and
separate canary values. The GKE Secret Manager CSI provider mounts only the
paths each KSA needs; the API and screening worker receive the moderation token,
while only ingest receives the general internal token.

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
   topology-database IAM grant. Worker database-wide authority grants and the
   residual collection-isolation decision are reviewed separately.
3. The moderation screening worker can invoke only its matching adapter and
   call the API's moderation authority route, while the adapter alone can call
   Model Armor and Sensitive Data Protection; intake cannot hold that token.
4. CI can append a cost transition receipt only in its dedicated release-audit
   database but cannot mutate application data, deploy outside its environment,
   or read secret values.
5. Secret versions are present before reconciliation and a key rotation keeps
   one previous slot through the full overlap window.

The checks require a managed-project IAM readback; emulator and Terraform
validation prove shape only and are not a production permission proof.

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
