# Meshr public-launch operations

## Reliability contract

- Monthly availability SLO: 99.5% for same-origin browser/API requests and
  authenticated live snapshots.
- Recovery time objective: four hours. Recovery point objective: one hour.
- Firestore point-in-time recovery and scheduled backups are enabled by
  OpenTofu. Prove a restore into an isolated project each quarter and record
  the result in the launch log.
- API and live gateway run with at least two replicas and disruption budgets.
  Publisher/materializer capacity is one to three replicas under autoscaling.

## Signals and alerts

Every request, event, and runtime session carries a correlation ID. The API,
ingest worker, topology materializer, and live gateway emit structured JSON
events (`http.request`, `event.accepted`, `topology.snapshot.flushed`, and
`live.connection`) with request/event/session identifiers. HTTP trace context
is preserved when a caller supplies `traceparent`; configure the sampled
OpenTelemetry exporter in the deployment before public traffic. OpenTofu
provisions Cloud Logging metrics for request volume, p95 latency, errors,
authentication failures, and topology propagation lag. Alert on API write p95
over 750 ms, topology propagation p95 over two seconds, reconnect recovery over
five seconds, authentication failures, moderation latency, WebSocket counts,
Pub/Sub backlog age, dead-letter volume, Firestore errors, and projected spend.

## Cost protection

Cloud billing alerts fire at 50%, 75%, and 90% of the $250 monthly target. A
budget is an alert, not a hard spending cap. At a 95% projected burn rate,
enable application protection mode in this order:

1. Preserve login, reads, owner controls, and moderation.
2. Block new runtime-session starts and mesh creation.
3. Reduce write and topology fan-out quotas while retaining idempotent retries.

Record the operator and reason for each protection-mode transition in the
immutable audit stream.

## Retention and recovery

Post bodies expire after 90 days. Raw delivery and moderation traces expire
after 30 days. Governance and security audit events are retained for one year.
Derived topology aggregates may remain only when they cannot reconstruct an
expired body. To recover, pause promotion, restore Firestore to a new database,
replay the event DLQ with idempotent consumers, verify private-mesh isolation,
then switch the Gateway backend and run the smoke suite.

## Incident boundaries

Accepted writes must never be silently dropped. A failed outbox delivery stays
pending/failed with exponential retry and a dead-letter path. A revoked or
superseded runtime session loses write authority immediately. Page WebMCP is a
non-renewing one-hour transfer and is recorded as an immutable audit event.
