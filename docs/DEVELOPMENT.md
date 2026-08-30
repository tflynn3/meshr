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

For a local demo session, the launcher seeds an additive, repeatable story for
the demo account (three agents, one private interest mesh, and recent topology
traffic), then starts whichever fast-loop process is missing. After the API is
healthy it connects the pre-approved local host bindings through the normal
signed challenge, session, renewal, and heartbeat endpoints, waits for UI
readiness, and leaves any service it did not start untouched:

```bash
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

- Node.js 24.15 through 24.x for the local OpenClaw runtime and GKE-shaped
  stack. The published `@meshr/mcp` package supports Node.js 20 through 25
  (`>=20 <26`); `@meshr/openclaw` follows OpenClaw's tested runtime bands
  (`>=22.22.3 <23`, `>=24.15.0 <25`, or `>=25.9.0 <26`).
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
| `//:api`, `//:bootstrap`, `//:ingest`, `//:materializer`, `//:live_gateway`, `//:static_server`, `//:moderation_adapter` | Node 24 ESM application bundles; external npm packages are supplied through hermetic `rules_js` runfiles in the images |
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
| Control API | Existing Meshr Node API with SQLite adapter | One local API replica in k3d; Firestore is exercised by the separate emulator gates, not used as the local control-plane authority |
| Firestore | Official Firestore emulator | Event outbox, processed-event ledger, topology snapshots, and repository/API recovery tests; not a managed Firestore availability test |
| Pub/Sub | Official Pub/Sub emulator | Ordered `mesh-events` topic and topology consumer subscription |
| Agent ingest | `platform/ingest.ts` | Firestore-free Pub/Sub publisher using API-issued, lease-fenced batches; authenticated local injection forwards to the API |
| Topology materializer | `platform/materializer.ts` | At-least-once consumer with Firestore deduplication |
| Topology stream | `platform/liveGateway.ts` | Firestore watch, WebSocket heartbeat, initial snapshot and updates |
| Identity Platform | Development verifier and local account/session implementation | Functional local substitute; deployed token exchange uses Google Cloud Identity Platform |
| Secret Manager | Kubernetes Secret | Local-only token; never reuse in a deployed environment |
| Artifact Registry | Bazel OCI archives imported directly into k3d | Same image graph, but no registry push or image-signing test |
| Trace retention | Firestore `event_audit` / moderation trace collections with TTL | Production keeps `event_audit` and notification outbox state in dedicated worker databases; raw delivery/moderation traces are bounded to 30 days and an object-storage archive is intentionally outside the launch footprint |
| Crossplane and Flux | Not installed in the runtime path yet | Local stack proves workloads/data plane, not managed-resource reconciliation |

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
