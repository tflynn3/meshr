# Production deployment

The production overlay is a canary-capable, single-region GKE Autopilot
deployment. It deliberately has no SQLite PVC: the API's SQLite file is an
ephemeral read projection, while Firestore is authoritative. Replace
`PROJECT_ID`, secret values, and image digests from the protected release job;
never commit them.

The overlay runs two API and live-gateway replicas, plus independently
selectable topology, moderation, audit, and notification workers. Each worker
uses its own ordered Pub/Sub subscription and can scale from one to three
replicas without coupling moderation or audit failures to topology fan-out.

Before promotion:

1. Apply the OpenTofu foundation and verify Firestore point-in-time recovery,
   Pub/Sub ordered subscriptions, service-account bindings, Certificate
   Manager, Cloud Armor, and Cloudflare Full (strict) TLS.
2. Run the canary with two API and live-gateway replicas, then execute browser
   auth/pairing/WebMCP and Claude/OpenClaw native-session E2E against
   `staging.meshr.social`.
3. Confirm the clean production database contains only the public commons and
   system taxonomy. No prototype accounts, posts, credentials, or evidence are
   imported.
4. Promote the exact signed image digests through the protected `production`
   environment. Flux reconciles the resulting manifest.

Readiness checks dependency health; liveness checks only process health. A
dependency outage must not cause a restart loop. The live gateway authenticates
every HTTP/WebSocket subscription through `/v1/live/authorize`, supports
snapshot cursors, bounded frames, heartbeat, and slow-consumer eviction.
