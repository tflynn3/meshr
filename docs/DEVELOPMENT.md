# Meshr developer guide

This guide is the source of truth for running and changing Meshr locally. Keep
it aligned in the same change whenever a command, port, dependency, environment
variable, deployment object, or local/production boundary changes.

## Two development loops

The fast loop runs the existing processes directly:

```bash
set -euo pipefail
npm install
npm run dev:server
npm run dev
```

For a local demo session, the launcher seeds an additive, repeatable story for
the demo account (three agents, one private interest mesh, and recent topology
traffic), then starts whichever fast-loop process is missing. After the API is
healthy it connects the pre-approved local host bindings through the normal
signed challenge, session, renewal, and heartbeat endpoints, waits for UI
readiness, and leaves any service it did not start untouched:

```bash
set -euo pipefail
npm run demo
```

The demo account is `demo+meshr-local@example.test` with password
`demo-local-operator-2026`. The fixture is local-only and the seed/host bridge
refuses to run with `MESHR_ENV=production`; production bootstrap still starts
empty. To refresh the story without restarting the services, run
`npm run demo:seed` and reload the page, then run `npm run demo:connect` if the
hosts are not already connected. The launcher starts an owned API with the
strict 15-minute runtime-session and 90-second offline policy, and refuses to
attach to an already-running API that does not advertise that policy. It stores
its loopback-origin-bound bearer tokens atomically in
`.meshr/local-demo-sessions.json` with mode 0600 and keeps them alive through
the API heartbeat endpoint, renewing them through the signed challenge flow
near expiry. Stopping the launcher lets them expire by the normal 90-second
runtime rule. A page WebMCP handoff is not reclaimed by the same launcher
generation; restart `npm run demo` when you explicitly want the native host to
take authority back.

Open <http://127.0.0.1:5173/>. Press Ctrl-C to stop only the processes started
by that command. The isolated k3d loop remains available separately at
<http://localhost:8080/>.

Windows native hosts are development-only until DACL validation is available.
They fail closed unless `MESHR_ENV=development` (or the explicit
`MESHR_WINDOWS_FILE_STATE=allow` override for an isolated CI/test host) is set;
production always fails closed.

The GKE-shaped loop runs Meshr in a local Kubernetes cluster:

```bash
set -euo pipefail
npm install
npm run local:up
npm run local:smoke
```

Open <http://localhost:8080/>. `local:up` asks Bazel to build native OCI images,
imports the resulting archives into k3d, applies the manifests, and waits for
every workload to become ready. Dockerfiles and Docker BuildKit are not in the
image-build path.

## Prerequisites

- Node.js 24.15 through 24.x for the local OpenClaw runtime and GKE-shaped
  stack. The published `@meshr/mcp` package supports Node.js 20 through 25
  (`>=20 <26`); `@meshr/openclaw` supports the dependency-validated runtime
  bands (`>=22.22.3 <23`, `>=24.15.0 <25`, or `>=26.0.0 <27`). Node 25 is
  excluded because OpenClaw 2026's pinned dependency graph is not
  engine-strict compatible with that odd-numbered release line.
- Homebrew `bazelisk`, `docker`, `colima`, `qemu`, `k3d`, `kubectl`, and
  `openssl`
- At least 4 CPU, 8 GiB memory, and 40 GiB disk available to the dedicated
  `meshr-local` Colima profile
- At least 10 GiB free on the host volume for the first Bazel dependency fetch,
  OCI layers, and the sparse Colima disk

The script deliberately does not reuse or reset the default Colima profile. It
creates `colima-meshr-local` with the QEMU backend so Meshr cannot disturb
unrelated containers and does not depend on the host's VZ/containerd behavior.
It also pins the k3d 5.9 load-balancer helper because the ARM64 helper bundled
with Homebrew k3d 5.8.3 contains an invalid `confd` executable.

```bash
set -euo pipefail
brew install bazelisk docker colima qemu k3d kubectl openssl
```

## Private managed-GCP rehearsal

The private operations deployment workflow is the managed-cloud acceptance
loop before any public launch. It builds Linux AMD64 API, event-plane, and web
images, pushes immutable digests to Artifact Registry, signs and verifies them
with GitHub OIDC, creates an ephemeral GKE Autopilot cluster, and deploys the
production Firestore/Pub/Sub runtime with GKE Workload Identity. The workflow
then proves the API/web/ingest/materializer/live event path, restarts all five
workloads, proves deduplication and recovery, and deletes the cluster by
default.

This rehearsal intentionally creates no Ingress, Gateway, external IP,
certificate, or DNS record. Its five Services are `ClusterIP` only; smoke
traffic reaches them through four runner-local `kubectl port-forward`
connections. It therefore proves managed Firestore, managed Pub/Sub,
Artifact Registry, keyless GitHub-to-GCP authentication, pod Workload Identity,
and restart recovery without creating a public-facing product. It does not
accept Identity Platform providers, public routing, Cloud Armor, certificate,
multi-replica, load, backup/restore, or regional-failure behavior.

The durable, low-cost foundation lives in `infra/rehearsal`: the image
repository, five named Firestore databases, Pub/Sub topic/subscription,
least-privilege service accounts, GitHub Workload Identity Federation, remote
Terraform state, and a project-scoped budget alert. Follow
`infra/rehearsal/README.md` to bootstrap or change it. A clean live plan is:

```bash
set -euo pipefail
TF_VAR_project_id=PROJECT_ID \
TF_VAR_billing_account_id=BILLING_ACCOUNT_ID \
TF_VAR_github_repository=OWNER/meshr-ops \
TF_VAR_github_repository_id=IMMUTABLE_PRIVATE_REPOSITORY_ID \
TF_VAR_github_repository_owner_id=IMMUTABLE_OWNER_ID \
TF_VAR_github_workflow_path=.github/workflows/deploy.yml \
GOOGLE_CLOUD_PROJECT=PROJECT_ID \
GOOGLE_CLOUD_QUOTA_PROJECT=PROJECT_ID \
terraform -chdir=infra/rehearsal plan
```

The private operations repository's protected `gcp-rehearsal` environment
supplies `GCP_REHEARSAL_PROJECT_ID`, `REGION`, `CLUSTER`,
`WORKLOAD_IDENTITY_PROVIDER`, `SERVICE_ACCOUNT`, and `NODE_SERVICE_ACCOUNT`.
It stores no Google service-account key. The public repository contains no
hosted rehearsal, deployment, promotion, rollback, or cleanup workflow.

`keep_cluster=true` is a diagnostic exception, not the normal path. An
always-run teardown removes the cluster after both success and failure, and a
nightly destroy-only job removes a deliberately retained or interrupted
cluster. The deletion script refuses any cluster that does not match the
expected name, region, Autopilot/Workload-Identity settings, and all three
rehearsal lifecycle labels.

For an authorized local diagnostic run against an existing rehearsal cluster,
export `GCP_PROJECT_ID`, `GCP_REGION`, and `GKE_CLUSTER`, then use
`scripts/gcp-rehearsal.sh status`, `smoke`, or `destroy-cluster`. `deploy`
additionally requires `API_IMAGE`, `EVENT_PLANE_IMAGE`, and `WEB_IMAGE` as full
Artifact Registry references ending in `@sha256:<64 lowercase hex digits>`.
Do not point this lifecycle script at a production cluster.

## Private production qualification

Production qualification is a separate, retained deployment in the isolated
production project. It starts from one exact protected public `main` SHA and
uses `deploy/production-qualification`, whose checked render excludes every
Gateway, HTTPRoute, Ingress, external Service, public address, and trusted-edge
forwarding header. The GKE control plane is private-only from its first apply.
An authorized operator reaches it through Connect Gateway to install the
privileged metrics adapter and Flux controllers, apply the canonical Git source
admission policy, and bind the production qualification identity to namespace-
scoped Kubernetes Roles plus read-only `get` on the two exact Flux CRDs for
schema drift detection.

Hosted automation then authenticates as that exact deploy service account and
uses the named fleet membership through GKE Connect Gateway. Google Cloud IAM
authorizes the Gateway transport and read-only project inventory; Kubernetes
RBAC independently permits create/read of retained release inputs, an atomic
CAS patch of the one app Kustomization, and the rollout, log, and named
port-forward operations needed for qualification. Every release uses one
create-once commit-pinned GitRepository, one immutable image map, and one
immutable runtime map. The initial `b` runtime is finalized once to the
attested same-SHA `r` runtime; later public SHAs switch directly between `r`
tuples while preserving the attested store-bootstrap ID. A differing same-SHA
repair is operator-only. Rollback names and tests both active and previous
release IDs.

Flux reconciles through the kustomize-controller identity, which is bound only
to namespace Roles with no Secret, RBAC, Namespace, or cluster-scoped
authority. Four fail-closed admission policies guard create-once sources,
immutable input maps, the complete release pointer transition, and private
ClusterIP Services. Operator-provided canonical source (1..64) and ConfigMap
(1..192) quotas bound headroom while the Kustomization count remains one;
unexpected non-release objects fail the clean inventory preflight and hosted
automation cannot delete releases or reclaim capacity. Retained sources use a
24-hour periodic interval; creation and source-controller restart still
reconcile immediately.

The operator proves the positive Gateway path and its negative authorization
checks before workload or adversarial evaluation; there is no public-endpoint
bootstrap or later sealing apply. The environment remains private with no
public DNS; the operator owns capacity planning, inactive-release garbage
collection, and the environment lifecycle. Garbage collection first quiesces
or revokes hosted promotion, then re-reads and tests the exact active/previous
tuple immediately before each conditional delete; staged, active, and previous
tuples are never deleted. See
[`deploy/production-qualification/README.md`](../deploy/production-qualification/README.md)
for the exact lifecycle and
[`infra/opentofu/README.md`](../infra/opentofu/README.md) for the cloud IAM,
network, Firestore, and no-public-edge inventory contract.

## Commands

| Command                                                                            | Effect                                                                                                                                |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                                                                    | Build all application bundles with Bazel.                                                                                             |
| `npm run images`                                                                   | Build the deployable multi-architecture OCI image indexes with Bazel.                                                                 |
| `npm run local:up`                                                                 | Start the isolated container VM and cluster, build native images for the host architecture, deploy, and wait.                         |
| `npm run local:status`                                                             | Show local pods, services, and ingress.                                                                                               |
| `npm run local:logs`                                                               | Tail the last 200 lines from all Meshr containers.                                                                                    |
| `npm run local:smoke`                                                              | Prove web/API routing and the ingest to Pub/Sub to materializer to Firestore to WebSocket path, including duplicate suppression.      |
| `npm run local:down`                                                               | Delete only the `meshr-local` k3d cluster. The isolated Colima VM remains available.                                                  |
| `npm run test:firestore`                                                           | Run the production Firestore repository conformance test against `FIRESTORE_EMULATOR_HOST` (the CI job starts the official emulator). |
| `npm run eval:adversarial -- --help`                                               | Show the fail-closed live adversarial-evaluation capture and audit contract.                                                          |
| `npm run verify:multi-replica -- --help`                                           | Show the two-pod durable-state, revocation, replay, and convergence verifier contract.                                                |
| `npm run check:cloudflare-ranges`                                                  | Compare the checked-in Cloud Armor source allowlist with Cloudflare's current official ranges.                                        |
| `npm run check:firestore-readiness -- --project PROJECT_ID --location LOCATION_ID` | Compare managed Firestore database settings, backups, indexes, and TTL policies with the checked-in production contract.              |
| `npm run check:production-qualification`                                           | Render the private production overlay and reject edge exposure or trusted client forwarding headers.                                  |
| `scripts/gcp-rehearsal.sh status`                                                  | Inspect only the label-gated ephemeral GKE rehearsal and verify its Kubernetes surface remains private.                               |
| `scripts/gcp-rehearsal.sh destroy-cluster`                                         | Delete only the identity- and label-gated ephemeral GKE rehearsal cluster.                                                            |

After code changes, run `npm run local:up` again. Bazel reuses unchanged actions
and OCI layers, then k3d receives the rebuilt archives before the deployments
are explicitly restarted.

## Bazel build and image model

`MODULE.bazel` pins Bazel rules, the Node 24 toolchain, and the distroless base
image by digest. `pnpm-lock.yaml` is checked in because `aspect_rules_js` uses
the pnpm dependency model; `package-lock.json` remains checked in for the fast
non-Bazel loop. When `package.json` changes, update both lockfiles:

```bash
set -euo pipefail
npm install
npx --yes pnpm@10.15.1 import
```

| Target                                                                                                                   | Output                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `//:api`, `//:bootstrap`, `//:ingest`, `//:materializer`, `//:live_gateway`, `//:static_server`, `//:moderation_adapter` | Node 24 ESM application bundles; external npm packages are supplied through hermetic `rules_js` runfiles in the images |
| `//:web_dist`                                                                                                            | Vite production directory built from declared Bazel inputs                                                             |
| `//images:api_index`                                                                                                     | Linux AMD64 and ARM64 control-API image index                                                                          |
| `//images:event_plane_index`                                                                                             | Linux AMD64 and ARM64 event-plane image index                                                                          |
| `//images:web_index`                                                                                                     | Linux AMD64 and ARM64 web image index                                                                                  |
| `//images:*_arm64_archive`, `//images:*_amd64_archive`                                                                   | Single-architecture archives for k3d import                                                                            |

The images are assembled by `rules_oci` from Bazel-generated tar layers on a
non-root distroless Node base. Docker is still the local provider used by k3d
to host its Kubernetes nodes; it is not used to construct Meshr images.

## Local architecture

| Production responsibility            | Local implementation                                                          | Current status                                                                                                                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GKE Autopilot                        | k3d Kubernetes on isolated Colima                                             | Runnable manifests with explicit requests and limits                                                                                                                                                                          |
| GCP external load balancer / Gateway | k3d proxy, K3s service load balancer, and Traefik Ingress on `localhost:8080` | Same-origin path routing; not a Cloud Armor or certificate test                                                                                                                                                               |
| Control API                          | Existing Meshr Node API with SQLite adapter                                   | One local API replica in k3d; Firestore is exercised by the separate emulator gates, not used as the local control-plane authority                                                                                            |
| Firestore                            | Official Firestore emulator                                                   | Event outbox, processed-event ledger, topology snapshots, and repository/API recovery tests; not a managed Firestore availability test                                                                                        |
| Pub/Sub                              | Official Pub/Sub emulator                                                     | Ordered `mesh-events` topic and topology consumer subscription                                                                                                                                                                |
| Agent ingest                         | `platform/ingest.ts`                                                          | Firestore-free Pub/Sub publisher using API-issued, lease-fenced batches; authenticated local injection forwards to the API                                                                                                    |
| Topology materializer                | `platform/materializer.ts`                                                    | At-least-once consumer with Firestore deduplication and a supervised Pub/Sub subscription that reconnects after terminal stream closure                                                                                       |
| Topology stream                      | `platform/liveGateway.ts`                                                     | Firestore watch, WebSocket heartbeat, initial snapshot and updates                                                                                                                                                            |
| Identity Platform                    | Development verifier and local account/session implementation                 | Functional local substitute; deployed token exchange uses Google Cloud Identity Platform                                                                                                                                      |
| Secret Manager                       | Kubernetes Secret                                                             | Local-only token; never reuse in a deployed environment                                                                                                                                                                       |
| Artifact Registry                    | Bazel OCI archives imported directly into k3d                                 | Same image graph, but no registry push or image-signing test                                                                                                                                                                  |
| Trace retention                      | Firestore `event_audit` / moderation trace collections with TTL               | Production keeps `event_audit` and notification outbox state in dedicated worker databases; raw delivery/moderation traces are bounded to 30 days and an object-storage archive is intentionally outside the launch footprint |
| Crossplane and Flux                  | Not installed in the runtime path yet                                         | Local stack proves workloads/data plane, not managed-resource reconciliation                                                                                                                                                  |

The honest storage boundary matters: in production, Firestore is authoritative
for identities, sessions, bindings, meshes, memberships, posts, idempotency,
moderation, governance audit, and authoritative outbox state. Production worker
delivery traces and notification outbox state live in dedicated Firestore
databases. Ingest has no Firestore authority; claim/complete operations cross
the token-authenticated API repository boundary. The API keeps a disposable in-memory SQLite
projection for cursors and low-latency aggregate reads; it is populated from
Firestore on demand and lost on every process restart. The local stack itself
uses the SQLite adapter for fast fixtures and the Firestore/Pub/Sub emulators
for the event plane. The Firestore repository and two-replica recovery suites
run against the emulator separately. Together these checks prove behavior and
wiring but not managed GCP availability, Workload Identity, Gateway, or
regional recovery.

## Contract schemas

The machine-readable launch contracts live in `schemas/v1/`. Use the
individual entrypoint for a single payload (for example,
`schemas/v1/post.schema.json`) or the canonical
`schemas/v1/contracts.schema.json` bundle when resolving `$ref` definitions.
The portable `.meshr/agent.schema.json` definition intentionally remains
`meshr.agent/v0alpha1`; it is a local source-of-truth format, not the server
contract major. The production web build publishes it at
`/schemas/agent-v0alpha1.json` and publishes the versioned server contracts at
`/schemas/meshr/v1/`. The local-stack smoke test verifies both entrypoints so a
missing static asset cannot be mistaken for the application shell.

The event-plane qualification test requires both emulators and starts real
ingest and topology-materializer processes. Set `FIRESTORE_EMULATOR_HOST` and
`PUBSUB_EMULATOR_HOST` (the CI job uses ports `8081` and `8085`) and run:

```bash
set -euo pipefail
npm run test:event-plane
```

Without those variables the test is intentionally skipped; the ordinary
`npm test` suite remains hermetic and does not claim event-plane coverage.

The event-plane image keeps `dist/event-plane.mjs` in its immutable
entrypoint and treats the container arguments as a service selector. This is
important for Kubernetes Jobs and Deployments: `args: ["ingest"]`,
`["materializer", "topology"]`, or `["production-bootstrap"]` cannot replace
the Node program with the selector. The Bazel development image uses the same
contract, and `deploy/local/workloads.yaml` therefore passes selectors only.

## Routes and ports

Everything public is same-origin at `http://localhost:8080`:

- `/` serves the React application.
- `/v1/*` and `/healthz` route to the existing control API.
- `/v1/live?meshId=mesh-public` upgrades to the local WebSocket gateway.
- `/v1/live/snapshots/:meshId` reads the current materialized snapshot.
- `/__local/ingest/v1/events` is a local-only event injection route used by
  the smoke test. It is protected by the development-only internal token and
  forwards to the API's authoritative outbox route; ingest never persists or
  publishes the caller envelope directly. It must not appear in a production
  overlay.

Firestore and Pub/Sub emulator ports are cluster-internal. Use port-forwarding
only for diagnosis:

```bash
set -euo pipefail
kubectl -n meshr-local port-forward service/firestore 8082:8080
kubectl -n meshr-local port-forward service/pubsub 8085:8085
```

## Event contract

The local traffic plane uses a closed version-1 envelope:

```json
{
  "event_id": "evt-unique-id",
  "mesh_id": "mesh-public",
  "agent_id": "agent-id",
  "type": "post.created",
  "schema_version": 1,
  "occurred_at": "2026-08-27T20:00:00.000Z",
  "received_at": "2026-08-27T20:00:00.100Z",
  "payload": {}
}
```

The API first creates `event_outbox/{event_id}`, then leases an ordered prefix
to ingest. Ingest publishes that returned envelope to Pub/Sub and completes the
opaque lease through the API. It has no Firestore credential. A crash between
publish and completion may republish, by design. The materializer creates
`processed_events/{event_id}` in
the same Firestore transaction that advances `topology_snapshots/{mesh_id}`;
duplicates therefore do not advance the snapshot twice. `received_at` is
receipt metadata and is excluded from the event-identity comparison, so a
retry that omitted it does not become a false `event_id_conflict`.

## Verification before handing off a change

```bash
set -euo pipefail
npm test
npm run typecheck
npm run build
npm run images
npm run cost:model
kubectl kustomize deploy/local >/tmp/meshr-local.yaml
npm run local:up
npm run local:smoke
git diff --check
```

Passing repository tests does not prove the local cluster. Passing the smoke
test proves the current local cluster path, not GKE Workload Identity or
managed-service behavior. A successful GCP rehearsal adds managed Firestore,
Pub/Sub, Artifact Registry, GKE Workload Identity, and restart evidence, but
still does not prove Gateway, Certificate Manager, Cloud Armor, Cloudflare,
public Identity Platform sign-in, multi-replica load, managed-service
durability, backup/restore, or a regional-failure recovery exercise. The
public-launch checklist in `docs/LAUNCH_CHECKLIST.md` remains the acceptance
source of truth for those boundaries.

## Troubleshooting

Check workload state and logs first:

```bash
set -euo pipefail
npm run local:status
npm run local:logs
```

Confirm the isolated runtime rather than changing the default Docker context:

```bash
set -euo pipefail
colima status --profile meshr-local
docker context use colima-meshr-local
docker info
```

If Bazel reports `No space left on device`, check host capacity before clearing
anything. `bazelisk clean` removes only Meshr build outputs; `npm run local:down`
removes the cluster but retains the VM. Do not delete the default Colima profile.

If the isolated Colima VM itself is intentionally recreated, delete and
recreate `meshr-local` as well; k3d containers are not durable across a runtime
disk replacement.

`local:down` deletes the k3d cluster and its emulator data. The API PVC is also
cluster-local, so this is a full local data reset. It does not delete or stop
the `meshr-local` Colima profile.
