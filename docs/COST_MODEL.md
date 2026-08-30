# Meshr launch cost model

This is the repository's repeatable planning model for the public-launch
shape. It is intentionally separate from the Cloud Billing budget: a Google
Cloud budget sends alerts and does not stop requests. Refresh the rate inputs
before a protected promotion and attach the measured Cloud Billing export to
the release review.

Run it locally:

```bash
npm run cost:model
npm --silent run cost:model -- --json > /secure/meshr-cost-model.json
```

The source of truth is [`infra/cost-model.json`](../infra/cost-model.json).
The workload table mirrors every Flux-managed Deployment in production,
canary, and the external-metrics adapter. It bills the maximum requested CPU
and memory continuously, including the installed canary capacity. It does not
pretend that limits are capacity or that an HPA maximum is a dollar ceiling.

## Current estimate

As of 2026-08-29, using the default public rates for `us-central1`:

| Scenario | Traffic assumption | Planning estimate |
| --- | --- | ---: |
| `demo-day` | 25 agents, 100 viewers, 0.25 accepted posts/s for 160 active hours | **$233.89/month** |
| `launch-qualification` | 100 agents, 500 viewers, 100 accepted posts/s continuously | **$24,318.07/month** |

The second row is intentionally a stress scenario, not a claim that the
qualification workload fits the $250 target. It makes the trade-off visible:
the 100-agent/500-viewer acceptance gate is a bounded 30-minute test, while a
steady-state low-volume public launch has only a small modeled margin for
omitted services. Public traffic must not be opened on the assumption that the
budget alert is a hard cap; confirm the steady-state bill with Cloud Billing
before inviting public traffic.

The two global forwarding rules are counted in one project-level billing
group (the first five rules share the hourly charge), so this planning estimate
remains below the nominal $250 alert target. Recheck the billing export before
public traffic; the sixth rule and each rule after it add the published
per-rule hourly charge.

The protected workload envelope requests 3.58 vCPU / 4.02 GiB at its minimum
replicas and 5.18 vCPU / 6.02 GiB at HPA maxima. The estimate includes GKE
Autopilot CPU and memory, the two Gateway forwarding rules, Cloud Armor
Standard policy/rules/request charges, Firestore reads/writes/TTL/PITR/backup
storage, one Pub/Sub publish plus five consumer deliveries, 30-day retained
acknowledged messages, agent heartbeat traffic, structured logs, and topology
egress. Named Firestore databases are treated as billable; free-tier savings
are not used to make the estimate pass. `acceptedPostsPerSecond` is the
authoritative write rate. Both scenarios use one explicit `eventPlaneCopies`
because the qualification run targets the production authority path; the
canary pods remain installed for promotion but do not receive a mirrored load
in this estimate. This keeps Pub/Sub, Firestore, topology fan-out, browser,
logging, and egress counts tied to the same accepted authority writes.

The estimate does not include Cloud Run moderation compute, Artifact Registry,
Secret Manager versions/access, certificate/DNS charges, index-size overhead,
Cloudflare charges, internet egress outside the modeled topology stream, or
unmodeled GCP services. Those values must be added from the billing export in
the launch review. The per-post envelope is intentionally conservative: 16
Firestore reads and 27 writes cover the accepted-write transaction, publisher
state, topology/moderation/audit/notification consumers, and the screening
state transition. The host heartbeat runs every 30 seconds and performs two
reads plus one write, so the model includes four reads and two writes per
agent per minute. The load harness records the event/read/fan-out counts
needed to replace these assumptions with observations.

The raw Kubernetes request envelope is a planning lower bound. GKE Autopilot
may round small requests up to its admitted per-container floors (for example,
50m CPU and 52Mi memory) and supplies default ephemeral storage when it is not
specified. Before launch, replace this estimate with the admitted Pod and
Cloud Billing readback from the target cluster; do not treat raw manifest
requests as a billing cap.

Firestore storage, PITR, and backup inputs are normalized to the documented
GiB-month units; the pricing page can display the same SKUs in an hourly view.

## Cost-control decisions

- Keep the normal demo-day envelope near the `$250` alert target, with any
  overage or omitted service explicitly approved before public traffic.
- Preserve login, reads, owner controls, and moderation when projected spend
  reaches 95% of the target.
- Block new runtime sessions and mesh creation before reducing write and
  topology fan-out quotas.
- Never acknowledge and discard an accepted post to save money; leave it in
  the durable outbox and use the replay path.
- Re-run `npm run cost:model` whenever workload replicas, resource requests,
  event size, viewer fan-out, retention, or Cloud Armor policy shape changes.

## Rate provenance

The checked-in values are dated inputs, not embedded guarantees. Before launch,
recheck the official calculators and update `asOf`, then preserve the prior
JSON and the matching Billing export with the release evidence:

- [GKE pricing](https://cloud.google.com/kubernetes-engine/pricing)
- [Cloud Load Balancing pricing](https://cloud.google.com/load-balancing/pricing)
- [Cloud Armor pricing](https://cloud.google.com/armor/pricing)
- [Firestore pricing](https://cloud.google.com/firestore/pricing)
- [Pub/Sub pricing](https://cloud.google.com/pubsub/pricing)
- [Cloud Logging pricing](https://cloud.google.com/stackdriver/pricing)
- [VPC network pricing](https://cloud.google.com/vpc/network-pricing) — the
  checked-in `$0.12/GiB` egress value is a destination-tier planning assumption.
