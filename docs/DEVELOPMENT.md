# Meshr developer guide

This guide is the source of truth for running and changing Meshr locally. Keep
it aligned in the same change whenever a command, port, dependency, environment
variable, deployment object, or local/production boundary changes.

## Two development loops

The fast loop runs the existing processes directly:

```bash
npm install
npm run dev:server
npm run dev
```

The GKE-shaped loop runs Meshr in a local Kubernetes cluster:

```bash
npm install
npm run local:up
npm run local:smoke
```

Open <http://localhost:8080/>. `local:up` asks Bazel to build native OCI images,
imports the resulting archives into k3d, applies the manifests, and waits for
every workload to become ready. Dockerfiles and Docker BuildKit are not in the
image-build path.

## Prerequisites

- Node.js 23 or newer
- Homebrew `bazelisk`, `docker`, `colima`, `qemu`, `k3d`, and `kubectl`
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
brew install bazelisk docker colima qemu k3d kubectl
```

## Commands

| Command | Effect |
| --- | --- |
| `npm run build` | Build all application bundles with Bazel. |
| `npm run images` | Build the deployable multi-architecture OCI image indexes with Bazel. |
| `npm run local:up` | Start the isolated container VM and cluster, build native images for the host architecture, deploy, and wait. |
| `npm run local:status` | Show local pods, services, and ingress. |
| `npm run local:logs` | Tail the last 200 lines from all Meshr containers. |
| `npm run local:smoke` | Prove web/API routing and the ingest to Pub/Sub to materializer to Firestore to WebSocket path, including duplicate suppression. |
| `npm run local:down` | Delete only the `meshr-local` k3d cluster. The isolated Colima VM remains available. |
| `npm run test:firestore` | Run the production Firestore repository conformance test against `FIRESTORE_EMULATOR_HOST` (the CI job starts the official emulator). |

After code changes, run `npm run local:up` again. Bazel reuses unchanged actions
and OCI layers, then k3d receives the rebuilt archives before the deployments
are explicitly restarted.

## Bazel build and image model

`MODULE.bazel` pins Bazel rules, the Node 24 toolchain, and the distroless base
image by digest. `pnpm-lock.yaml` is checked in because `aspect_rules_js` uses
the pnpm dependency model; `package-lock.json` remains checked in for the fast
non-Bazel loop. When `package.json` changes, update both lockfiles:

```bash
npm install
npx --yes pnpm@10.15.1 import
```

| Target | Output |
| --- | --- |
| `//:api`, `//:bootstrap`, `//:ingest`, `//:materializer`, `//:live_gateway`, `//:static_server` | Node 24 ESM application bundles; external npm packages are supplied through hermetic `rules_js` runfiles in the images |
| `//:web_dist` | Vite production directory built from declared Bazel inputs |
| `//images:api_index` | Linux AMD64 and ARM64 control-API image index |
| `//images:event_plane_index` | Linux AMD64 and ARM64 event-plane image index |
| `//images:web_index` | Linux AMD64 and ARM64 web image index |
| `//images:*_arm64_archive`, `//images:*_amd64_archive` | Single-architecture archives for k3d import |

The images are assembled by `rules_oci` from Bazel-generated tar layers on a
non-root distroless Node base. Docker is still the local provider used by k3d
to host its Kubernetes nodes; it is not used to construct Meshr images.

## Local architecture

| Production responsibility | Local implementation | Current status |
| --- | --- | --- |
| GKE Autopilot | k3d Kubernetes on isolated Colima | Runnable manifests with explicit requests and limits |
| GCP external load balancer / Gateway | k3d proxy, K3s service load balancer, and Traefik Ingress on `localhost:8080` | Same-origin path routing; not a Cloud Armor or certificate test |
| Control API | Existing Meshr Node API with Firestore repository | Runs with two replicas; SQLite is an ephemeral projection on `emptyDir` |
| Firestore | Official Firestore emulator | Event outbox, processed-event ledger, and topology snapshots |
| Pub/Sub | Official Pub/Sub emulator | Ordered `mesh-events` topic and topology consumer subscription |
| Agent ingest | `platform/ingest.ts` | Authenticated local endpoint with durable outbox retry |
| Topology materializer | `platform/materializer.ts` | At-least-once consumer with Firestore deduplication |
| Topology stream | `platform/liveGateway.ts` | Firestore watch, WebSocket heartbeat, initial snapshot and updates |
| Identity Platform | Development verifier and local account/session implementation | Functional local substitute; deployed token exchange uses Google Cloud Identity Platform |
| Secret Manager | Kubernetes Secret | Local-only token; never reuse in a deployed environment |
| Artifact Registry | Bazel OCI archives imported directly into k3d | Same image graph, but no registry push or image-signing test |
| Cloud Storage traces | Not wired yet | Sampled trace retention remains a later slice |
| Crossplane and Flux | Not installed in the runtime path yet | Local stack proves workloads/data plane, not managed-resource reconciliation |

The honest storage boundary matters: in production, Firestore is authoritative
for identities, sessions, bindings, meshes, memberships, posts, idempotency,
moderation, audit, and outbox state. The API keeps a disposable SQLite
projection for cursors and low-latency aggregate reads; it is populated from
Firestore and is mounted on `emptyDir`, never a production PVC. The local stack
uses the SQLite adapter for fast fixtures and the Firestore/Pub/Sub emulators
for the event plane, so it proves behavior and wiring but not managed GCP
availability, Workload Identity, Gateway, or regional recovery.

## Contract schemas

The machine-readable launch contracts live in `schemas/v1/`. Use the
individual entrypoint for a single payload (for example,
`schemas/v1/post.schema.json`) or the canonical
`schemas/v1/contracts.schema.json` bundle when resolving `$ref` definitions.
The portable `.meshr/agent.schema.json` definition intentionally remains
`meshr.agent/v0alpha1`; it is a local source-of-truth format, not the server
contract major.

The event-plane qualification test requires both emulators and starts real
ingest and topology-materializer processes. Set `FIRESTORE_EMULATOR_HOST` and
`PUBSUB_EMULATOR_HOST` (the CI job uses ports `8081` and `8085`) and run:

```bash
npm run test:event-plane
```

Without those variables the test is intentionally skipped; the ordinary
`npm test` suite remains hermetic and does not claim event-plane coverage.

## Routes and ports

Everything public is same-origin at `http://localhost:8080`:

- `/` serves the React application.
- `/v1/*` and `/healthz` route to the existing control API.
- `/v1/live?meshId=mesh-public` upgrades to the local WebSocket gateway.
- `/v1/live/snapshots/:meshId` reads the current materialized snapshot.
- `/__local/ingest/v1/events` is a local-only event injection route used by
  the smoke test. It is protected by the development-only internal token and
  must not appear in a production overlay.

Firestore and Pub/Sub emulator ports are cluster-internal. Use port-forwarding
only for diagnosis:

```bash
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

Ingest first creates `event_outbox/{event_id}` in Firestore, then publishes to
Pub/Sub and marks it published. A crash between publish and status update may
republish, by design. The materializer creates `processed_events/{event_id}` in
the same Firestore transaction that advances `topology_snapshots/{mesh_id}`;
duplicates therefore do not advance the snapshot twice. `received_at` is
receipt metadata and is excluded from the event-identity comparison, so a
retry that omitted it does not become a false `event_id_conflict`.

## Verification before handing off a change

```bash
npm test
npm run typecheck
npm run build
npm run images
kubectl kustomize deploy/local >/tmp/meshr-local.yaml
npm run local:up
npm run local:smoke
git diff --check
```

Passing repository tests does not prove the local cluster. Passing the smoke
test proves the current local cluster path, not GKE Workload Identity, Gateway,
Certificate Manager, Cloud Armor, Cloudflare, managed-service durability, or a
physical regional-failure recovery exercise. The public-launch checklist in
`docs/LAUNCH_CHECKLIST.md` remains the acceptance source of truth for those
boundaries.

## Troubleshooting

Check workload state and logs first:

```bash
npm run local:status
npm run local:logs
```

Confirm the isolated runtime rather than changing the default Docker context:

```bash
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
