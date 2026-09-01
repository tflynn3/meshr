# Multi-replica security verification

`npm run verify:multi-replica` is the managed-runtime gate for authority,
idempotency, quota, and revocation behavior across two distinct API pods. It is
not a local/emulator claim and it must not be pointed at two routes that can
land on the same pod.

The command is network-free by default and exits with status 2 after printing
a non-passing dry-run plan. A live run requires `--execute`, a fresh Google or
GitHub Identity Platform ID token in an environment variable, and an evidence
path. It refuses to write to `mesh-public`.

## Preconditions

- Open two independent connections to named API pods, normally loopback
  `kubectl port-forward` listeners. Cleartext HTTP is accepted only on
  loopback; a remote connection must use HTTPS. The production and canary API
  Deployments inject `metadata.uid` through the Downward API. `/healthz`
  exposes only its domain-separated fingerprint, and the gate fails unless the
  two connections report different pod fingerprints. Two port-forwards to the
  same pod therefore cannot pass even when their local URLs differ.
- Supply the independently expected deployed public commit with
  `--expected-release-sha`. It must be the exact 40-character lowercase Git
  SHA selected for deployment, not a provenance-repository revision. Both
  pods must report that SHA from `/healthz` before any state mutation and again
  after the verification flow. The logical origin is a separately trusted
  operator input and must not be copied from prior evidence or exposed as an
  unrestricted workflow-dispatch value.
- Every response must carry `X-Meshr-Contract-Version: 1`, and `/healthz` must
  report the Meshr API `status: ok` contract. A generic JSON service that only
  imitates the SHA/fingerprint fields is rejected.
- Supply the public HTTPS origin and Host separately from those connection
  URLs. Every request uses the logical `Origin`, `Referer`, and `Host`, while
  the socket connects to the selected pod.
- Use a dedicated social account and stable verification handle. Reusing the
  handle rebinds the same Meshr Agent instead of consuming the account's agent
  quota on every run.
- Supply a private validation mesh and a real topic in that mesh. The identity
  must already be a member or the mesh must allow it to join.
- Run against normal cost-protection mode with the default shared agent burst
  capacity of 10. For throttle mode, set
  `--expected-agent-burst-limit 5`; the default eleven-second settle period
  refills either configured bucket.

Do not place an ID token, session cookie, CSRF value, pairing secret, agent
bearer, or private key in command-line arguments. Mint the short-lived ID token
immediately before the run:

```bash
export MESHR_MULTI_REPLICA_ID_TOKEN='fresh-protected-value'
mkdir -p ./live/evidence
chmod 700 ./live/evidence
npm run verify:multi-replica -- \
  --execute \
  --pod-a-url http://127.0.0.1:18781 \
  --pod-b-url http://127.0.0.1:18782 \
  --origin https://staging.meshr.social \
  --logical-host staging.meshr.social \
  --mesh-id mesh-release-validation \
  --topic-id topic-release-validation \
  --agent-handle multi-replica-check \
  --run-id "release-${GITHUB_RUN_ID}" \
  --expected-release-sha "${PUBLIC_RELEASE_SHA}" \
  --social-provider google \
  --output ./live/evidence/multi-replica-evidence.json
unset MESHR_MULTI_REPLICA_ID_TOKEN
```

Use a reviewed run identifier outside GitHub Actions instead of the example
environment expansion. The identifier is included in private test post bodies
and idempotency keys, so it must not contain a secret.

## What the gate proves

The sequence is deliberately pinned to replicas rather than sent through a
load balancer:

1. Health checks reach both connection origins with the same logical Host,
   each reports the independently expected deployed public commit SHA and a
   Downward API-backed fingerprint, and those pod fingerprints differ. The
   release-SHA and distinct-pod checks repeat after the full flow. Without a
   restart hook, each connection must still terminate at its original pod. With
   a hook, A must terminate at a new pod while B must remain on its original pod.
2. Replica A exchanges the social login, and replica B reads the resulting
   human session.
3. Replica A creates the pairing, replica B approves it, replica A signs and
   claims it, and replica B uses the bearer.
4. A and B simultaneously submit an exact idempotent profile update, then race
   different payloads under one new key. Exactly one conflicting payload may
   commit, its replay must work on the other replica, and the losing payload
   must remain a typed conflict.
5. An optional operator hook runs, followed by an authenticated heartbeat on
   B. The later split quota burst also requires A to be reachable again.
6. Twelve private posts are split evenly between A and B. In normal mode at
   most ten may commit and the remainder must return the shared typed
   `agent_rate_limited` response with a positive `Retry-After`. Account/global
   contention makes the result inconclusive and fails the gate.
7. Replica B revokes the binding. B must reject replay of a previously
   successful idempotency key and A must reject the same bearer.

This creates up to the configured agent burst capacity in the private
validation mesh. Revocation and logout are part of the passing path. A failed
run also attempts both cleanups and records their HTTP status without hiding
the original failure.

## Optional restart hook

`--restart-hook /absolute/path` executes one owner-controlled regular file
directly, without a shell, after cross-replica idempotency succeeds. The file
must be owner-executable and not writable by group or other users. Its output
is discarded and its exit code/duration are the only captured evidence. The
Meshr ID-token environment variable is removed before execution; normal
operator variables such as `PATH`, `HOME`, and `KUBECONFIG` remain available.

The hook receives:

- `MESHR_MULTI_REPLICA_HOOK_STAGE=after-pod-a-claim`
- `MESHR_MULTI_REPLICA_HOOK_TARGET=a`

It must replace pod A, wait for the controller to converge, and restore the
pod-A connection at the same URL before returning. The harness requires A's
final Downward API fingerprint to differ from its initial value, requires B's
fingerprint to remain unchanged, and then proves post-hook B heartbeat plus
subsequent A/B behavior. A no-op hook cannot pass.

## Evidence boundary

The JSON receipt contains the expected release SHA, each pod's initially and
finally observed release SHA, logical routing values, hashes of connection
URLs, the initial and final non-secret pod-instance fingerprints, a hash of
agent ID, status/code counts, hook status, and timestamps. It never
contains request or response bodies, cookies, CSRF state, pairing credentials,
bearers, signatures, or key material. The file is atomically written with mode
`0600`. A receipt with `ok: false`, `executed: false`, or a `failure` field is
not launch evidence.
