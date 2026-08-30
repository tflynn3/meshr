# Recovery and disruption drills

This runbook defines the evidence required for the four-hour RTO and one-hour
RPO. It is intentionally separate from the local emulator smoke: a green
emulator run proves protocol behavior, not managed GCP recovery.

## Drill matrix

| Drill | Procedure | Pass evidence |
| --- | --- | --- |
| Pod loss | Evict one API and live-gateway Pod while the canary load smoke is running; separately delete an ingest or singleton worker Pod to exercise restart recovery. Repeat with one serving replica unavailable. | API/live-gateway PDBs keep one serving replica. Ingest and worker restarts recover from the durable outbox/subscriptions; no accepted write is lost, backlog drains, and topology cursor recovery is below five seconds. Direct deletion of a singleton is not evidence of PDB protection. |
| Gateway disconnect | Terminate a viewer socket and roll the live gateway Deployment. | The client reconnects with jitter, resumes from its cursor, receives no duplicate topology revision, and remains authorized. |
| Firestore interruption | Inject a bounded Firestore outage or deny the workload IAM binding, then restore it. | Readiness goes false without a liveness restart loop; accepted writes fail explicitly or remain retryable; no stale session regains authority after recovery. |
| Duplicate/reordered events | Publish the same event twice and deliver a later event before an earlier event to the worker subscriptions. | Idempotency ledger prevents duplicate projections and the materializer converges to the same snapshot after replay. |
| DLQ replay | Force a bounded worker failure, confirm dead-letter forwarding, run the dry-run first, then apply a reviewed bounded replay from an operator environment. | Apply republishes events, records an immutable receipt in the dedicated release-audit database, and only then acknowledges the DLQ messages. Downstream idempotency restores the projection without exposing post bodies. |
| Firestore restore | Restore the authority database into an isolated named database. Provision a fresh empty topology database (do not restore populated projections), authorize both with `additional_*_database_names`, suspend Flux, fence and quiesce all database readers and the force-reconciled bootstrap Job, and capture the source outbox high-watermark. Restore the authority, copy the fence-bound authority delta with matching per-collection SHA-256 manifests (sorted collection name, count, and digest), replay the bounded source delta into the fresh topology, and produce a schema-2 cutover receipt with a unique `receipt_id` and recent `issued_at`. The protected promotion workflow must pass `npm run verify:cutover-receipt` and atomically consume that receipt in the isolated release-audit database before switching the runtime values; a retry after rollback requires a new receipt. Run the generation-fenced one-shot bootstrap Job, attest its generation, resume Flux, and run the session-only private root/reply smoke before reopening writes. Stage the renewed validation session, CAS-promote it while writes are still fenced, reopen writes within the twelve-minute protected-session deadline, then heartbeat before reading the canonical profile and retire the predecessor only after that check passes. A deadline failure leaves the successor pointer intact and requires operator-led roll-forward. | Private-mesh isolation, last-owner protection, session fences, topology snapshots, and the authenticated smoke all pass before the old database is retired; the receipt proves fence-before-restore, complete per-collection authority-delta equality, replay ordering, and equal source/target outbox high-watermarks, with no old/new worker overlap during the cutover. |
| Cluster rebuild | Recreate the GKE cluster from OpenTofu, reinstall Gateway API/Flux/metrics adapter, restore protected substitutions, and reconcile the pinned release. | Every managed resource is observed by its owning controller, Gateway/TLS becomes ready, two replicas are serving, and no resource is accidentally recreated or deleted. |
| Regional loss | Record the single-region boundary and simulate loss of the region in the disaster plan. | The review records that active-active failover is not a launch feature; RTO/RPO escalation and operator communication are exercised instead of claiming availability that is not provided. |

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
