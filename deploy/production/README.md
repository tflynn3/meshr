# Production manifests

This directory is the canonical Kubernetes overlay for Meshr's single-region
GKE Autopilot deployment. It contains the public Gateway and runtime workloads;
the presence of those objects is not evidence that a particular release has
passed qualification.

Applying or promoting these manifests belongs to protected private operations.
Do not replace image placeholders, secrets, release SHAs, database IDs, or
moderation endpoints by hand.

## Runtime shape

The overlay runs:

- two API replicas backed by authoritative Firestore;
- two static web replicas with no Google service account;
- two to three ingest replicas that lease the transactional outbox through the
  API and publish ordered events;
- one to three independently scaled topology, moderation, audit, and
  notification workers; and
- two live-gateway replicas that read aggregate topology and authorize each
  HTTP/WebSocket subscription through the API.

API and live-gateway disruption budgets retain one serving replica. Readiness
checks dependencies; liveness checks process health. A dependency outage must
not create a restart loop.

The default overlay has no SQLite volume. Firestore owns accepted identity,
authority, and social state; topology and worker traces use separately named
databases. The bootstrap Job creates the public commons and publishes a
generation-fenced projection attestation before readers become ready.

## Public edge

The `HTTPRoute` sends `/v1/live` to the live gateway, `/v1` to the API, and all
other paths to the static web service. Bare `/healthz` and `/readyz` are pod
health endpoints and are not exposed by this route; operator checks must use a
named pod or Connect Gateway port-forward.

The Gateway assumes the OpenTofu-managed certificate map, Cloud Armor policy,
reserved address, Cloudflare origin controls, and exact trusted-forwarding
contract. The staging listener lives in the separate canary overlay and uses
distinct services and identities.

## Release inputs

Protected Flux release maps substitute immutable image digests and runtime
values. A release must keep these properties:

- API, event-plane, web, live-gateway, moderation-adapter, and bootstrap images
  resolve to the reviewed source SHA and signed receipt;
- authority, topology, audit, notification, moderation, and release-audit
  database IDs remain explicit;
- a cost-protection transition changes the protected runtime map and rolls the
  affected workloads;
- the API's reported release SHA changes with the image tuple; and
- the production moderation worker fails closed unless the authenticated,
  release-bound adapter is configured.

Public CI verifies and publishes source-bound image evidence but has no hosted
deployment or promotion authority. The private operations repository verifies
that evidence and owns staging, promotion, rollback, and runtime-map changes.
See [Production operations](../../docs/OPERATIONS.md#release-controls) for the
canonical release-control contract.

## Private qualification path

The edge-free qualification overlay is deliberately separate:
[deploy/production-qualification](../production-qualification/README.md). It
uses private GKE control-plane access, Connect Gateway, namespace-scoped Flux
RBAC, immutable release inputs, and no Gateway, HTTPRoute, Ingress, public
Service, address, or DNS record.

Do not apply the public canary or production inputs to that cluster. Never run
raw `flux install`; its default controller authority is broader than the
reviewed qualification boundary. A qualification result does not authorize a
public edge.

## Data and replay boundaries

Delivery workers have no authority-Firestore IAM. Ingest leases committed
outbox rows through the token-authenticated API broker. Moderation decisions
cross a revision-fenced API route; screening workers cannot mutate posts
directly. The live gateway reads aggregate topology only.

Use the canonical runbooks rather than copying operator commands here:

- [Recovery drills](../../docs/RECOVERY_DRILLS.md) — outbox/DLQ replay,
  database restore, disruption, and cutover receipts.
- [Operations](../../docs/OPERATIONS.md) — runtime evidence, load, cost
  protection, retention, and incident boundaries.
- [IAM matrix](../../docs/IAM_MATRIX.md) — exact workload and release
  identities.
- [Production release qualification](../../docs/LAUNCH_CHECKLIST.md) — the
  complete acceptance gate.

## Acceptance boundary

`kubectl kustomize deploy/production` proves that the overlay renders. Unit
tests and emulators prove application contracts. Neither proves managed login,
DNS/TLS, provider behavior, multi-replica recovery, load, restore, security, or
cost acceptance for a deployed release.

Version `0.1.1` of both public integration packages is published. A release
still needs clean-environment installation and exact-origin root/reply checks
for its supported runtimes. Codex direct native MCP writes remain Beta until
that acceptance path passes.
