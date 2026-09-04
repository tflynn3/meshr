# Recovery and disruption drills

This runbook defines the evidence required for the four-hour RTO and one-hour
RPO. It is intentionally separate from the local emulator smoke: a green
emulator run proves protocol behavior, not managed GCP recovery.

## Drill index

| Drill | Required result |
| --- | --- |
| Pod loss | Serving replicas remain available and durable work recovers. |
| Gateway disconnect | Authorized clients resume without duplicate revisions. |
| Firestore interruption | Readiness fails without a restart loop or stale authority. |
| Duplicate/reordered events | Idempotent workers converge on one projection. |
| DLQ replay | A reviewed batch is republished, receipted, then acknowledged. |
| Firestore restore | Authority and fresh projections cut over under writer fencing. |
| Cluster rebuild | Controllers reconstruct the pinned release. |
| Regional loss | Operators exercise the documented single-region escalation. |

### Pod loss

Evict one API and live-gateway Pod while the canary load smoke runs. Separately
delete an ingest or singleton worker Pod, then repeat with one serving replica
unavailable. API/live-gateway disruption budgets must keep one replica serving;
durable outbox/subscription work must drain after restart with no accepted-write
loss and topology cursor recovery below five seconds. Deleting a singleton does
not prove disruption-budget behavior.

### Gateway disconnect

Terminate one viewer socket and roll the live-gateway Deployment. The client
must reconnect with jitter, resume from its cursor, receive no duplicate
topology revision, and remain authorized.

### Firestore interruption

Inject a bounded outage or temporarily deny the workload IAM binding, then
restore it. Readiness must go false without a liveness restart loop. Writes must
fail explicitly or remain retryable, and no stale session may regain authority
after recovery.

### Duplicate and reordered events

Publish the same event twice and deliver a later event before an earlier one.
The idempotency ledger must prevent duplicate projections, and replay must
converge on the same snapshot.

### DLQ replay

Force a bounded worker failure, confirm dead-letter forwarding, review the
read-only dry-run, then apply only the selected batch from an operator
environment. Apply must publish the events, write an immutable receipt to the
release-audit database, and only then acknowledge messages. Downstream
idempotency must restore the projection without exposing post bodies. The exact
commands are in [DLQ replay procedure](#dlq-replay-procedure).

### Firestore restore

Restore authority into an isolated named database and provision a fresh, empty
topology database; never restore populated projections. Explicitly authorize
both database IDs, suspend Flux, and fence and quiesce every database reader and
the force-reconciled bootstrap Job. Capture the source outbox high-watermark.

Copy the fence-bound authority delta and require equal per-collection SHA-256
manifests sorted by collection name, count, and digest. Replay the bounded source
delta into the fresh topology database. Produce a schema-2 cutover receipt with
a unique `receipt_id` and recent `issued_at`; the protected workflow must run
`npm run verify:cutover-receipt` and atomically consume the receipt in the
isolated release-audit database before runtime values switch. A retry after
rollback needs a new receipt.

Run the generation-fenced bootstrap Job, attest its generation, resume Flux,
and run the session-only private root/reply smoke before reopening writes.
Stage the renewed validation session and enforce enough remaining lifetime to
complete rollout, heartbeat, and profile verification with a 60-second reserve.
Retire the predecessor only after that check. A deadline failure keeps the
successor pointer and requires operator-led roll-forward.

Pass evidence must show private-mesh isolation, last-owner protection, session
fences, topology snapshots, authenticated smoke, fence-before-restore,
per-collection equality, replay ordering, equal source/target outbox
high-watermarks, and no old/new worker overlap.

### Cluster rebuild

Recreate the GKE cluster from OpenTofu, reinstall Gateway API, Flux, and the
metrics adapter, restore protected substitutions, and reconcile the pinned
release. Every managed resource must be observed by its owning controller;
Gateway/TLS must become ready with two serving replicas and no accidental
resource recreation or deletion.

### Regional loss

Record and simulate the single-region loss plan. The exercise must treat
active-active failover as unsupported and test the RTO/RPO escalation and
operator communication instead.
## Evidence format

Store a redacted JSON record outside the repository with:

- release SHA, environment, drill ID, operator, and UTC start/finish times;
- request, event, session, and trace correlation IDs;
- accepted-write count before/after, outbox/DLQ counts, and topology revision;
- recovery latency histograms and the exact restore database IDs;
- IAM/Gateway/Certificate Manager/Flux observations; and
- links to Cloud Monitoring and Cloud Billing export slices.

Never include cookies, bearer tokens, private keys, post bodies, or provider
responses. A drill is failed if an accepted write disappears, an unauthorized
session can publish after supersession, a private row appears in a public
projection, or a restore cannot be rolled back within the stated objectives.

During a cutover validation window, the smoke runner may renew only the
pre-approved binding, agent, and predecessor session tuple that is already
joined to the private validation mesh. The API checks the exact tuple and
membership against the restored authority before issuing a renewal challenge;
new runtime-session starts and all other pairing challenges remain fenced until
the cutover is committed.

## DLQ replay procedure

`npm run replay:dlq` is deliberately a read-only dry-run. Capture its bounded
summary and review the event count and route-qualified selectors before applying anything. Set
`MESHR_REPLAY_ENVIRONMENT` to bind the dead-letter subscription, destination
topics, and release-audit database to one production or canary tuple. A
reviewed apply must pass those exact `event_id` values in
route-qualified selectors from that redacted summary (for example
`events:event-123` or `moderation-screening:event-123`), name the matching
release-audit database, and keep the same bounded maximum; it republishes only
that reviewed batch, writes the receipt, and acknowledges only after both
operations succeed. A bare event ID is rejected because an envelope and its
screening job may intentionally share an ID. Dry-runs release all leases
immediately. Selected apply leases are extended to the Pub/Sub service maximum
as they are found and renewed every 30 seconds while the batch is being
processed:

```bash
GOOGLE_CLOUD_PROJECT="$PROJECT_ID" \
MESHR_REPLAY_ENVIRONMENT=production \
MESHR_DLQ_SUBSCRIPTION="mesh-events-dlq-replay" \
MESHR_REPLAY_MAX=100 \
npm --silent run replay:dlq > /secure/dlq-review.json
```

Set `REVIEWED_EVENT_SELECTORS` from the summary's `selectors` field
(comma-separated route-qualified values) for the apply command below.

```bash
GOOGLE_CLOUD_PROJECT="$PROJECT_ID" \
MESHR_REPLAY_ENVIRONMENT=production \
MESHR_DLQ_SUBSCRIPTION="mesh-events-dlq-replay" \
MESHR_EVENTS_TOPIC="mesh-events" \
MESHR_REPLAY_MAX=100 \
MESHR_REPLAY_EVENT_IDS="$REVIEWED_EVENT_SELECTORS" \
MESHR_AUDIT_FIRESTORE_DATABASE="meshr-release-audit" \
MESHR_REPLAY_APPLY=1 \
npm run replay:dlq
```

Pub/Sub dead-letter messages carry the source subscription as an attribute.
The replay validates that attribute and routes event envelopes back to
`mesh-events` and moderation-screening jobs back to `moderation-screening`,
including the canary pair; an unknown or malformed contract is released and
fails closed. The receipt contains event IDs, routes, count, source,
completion uncertainty, and operator run ID, never message bodies. If publish,
receipt creation, or the acknowledgement fails, the message remains available
for retry. Use
`MESHR_REPLAY_SOURCE=outbox` with explicit `MESHR_REPLAY_ENVIRONMENT`,
`MESHR_REPLAY_SINCE`, and `MESHR_REPLAY_UNTIL` for an outbox range; selectors
must use the `events:event_id` route. Outbox replay binds the authority
database and destination topic to the selected environment. For a reviewed
restore source, keep `MESHR_FIRESTORE_DATABASE` set to the environment's
authority database and add `MESHR_REPLAY_RESTORE_DATABASE` plus
`MESHR_REPLAY_RESTORE_APPROVAL=database:<restore_database_id>` as an explicit
per-database review marker; live production and canary authority databases are
rejected as restore sources. The selected restore database is recorded in the
receipt and checkpoint. An apply in either source requires the dedicated
`MESHR_AUDIT_FIRESTORE_DATABASE`.

Outbox checkpoints are version 2 and bind the environment, authority database,
restore database, event topic, and audit database. Resuming a checkpoint with
any changed tuple is rejected; start a new reviewed range instead.

## Execution boundary

The repository currently proves duplicate/reordered event handling, WebSocket
snapshot-plus-cursor recovery, and fresh-replica Firestore recovery against
official emulators. The managed pod, Gateway, Firestore restore, cluster
rebuild, and regional drills remain launch gates and must be run in the clean
GCP project after credentials and DNS are configured.
