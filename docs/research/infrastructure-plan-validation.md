# Meshr infrastructure plan validation

Researched 2026-08-27 against current Google Cloud, Cloudflare, Crossplane/provider, and Firebase first-party documentation.

## Verdict

**Valid with significant corrections; not deploy-ready as written.** A single regional GKE Autopilot cluster, Firestore control data, Pub/Sub event transport, a GKE Gateway, and Cloudflare can form a sound first production architecture. The service choices are compatible and most quoted free tiers are correct. However:

1. `$120-$175/month`, with growth "kept near $200," is not an enforceable ceiling and is optimistic without a measured workload and traffic model.
2. `provider-upjet-cloudflare` is not currently a production-grade dependency that can simply be version-pinned.
3. Pub/Sub ordering and subscription semantics do not supply the routing or WebSocket fan-out described in the prose.
4. Cloudflare-IP allowlisting is useful origin hardening, but does not strongly authenticate traffic as coming through this specific Cloudflare zone.
5. Recovery, idempotency, WebSocket reconnects, Firestore backup policy, and service-level IAM need to be explicit before deployment.

## What is factually sound

- GKE Gateway supports Autopilot and can provision a global or regional external Application Load Balancer. Cloud Armor is attached to Gateway backends with a `GCPBackendPolicy`; Gateway does not attach it by default ([GKE Gateway deployment](https://cloud.google.com/kubernetes-engine/docs/how-to/deploying-gateways), [Gateway policies](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/configure-gateway-resources)).
- Certificate Manager supports Google-managed public certificates with DNS authorization. A global GKE Gateway references a Certificate Manager certificate map; a regional Gateway references regional Certificate Manager certificates directly. Cloudflare `Full (strict)` accepts an unexpired publicly trusted origin certificate with a matching hostname. The DNS-authorization CNAME should be **DNS only**, because Cloudflare recommends not proxying domain-verification CNAMEs ([GKE Gateway certificates](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/secure-gateway), [Certificate Manager DNS authorization](https://docs.cloud.google.com/certificate-manager/docs/certificates), [Cloudflare Full strict](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/), [Cloudflare proxy status](https://developers.cloudflare.com/dns/proxy-status/)).
- Identity Platform directly supports Google, GitHub, and Microsoft social login. Those are Tier 1 providers, for which the first 50,000 MAU are free. Generic OIDC and SAML are Tier 2 and have only 50 free MAU per project, so Microsoft should use the built-in Microsoft provider if the plan assumes Tier 1 pricing ([Identity Platform how-to index](https://docs.cloud.google.com/identity-platform/docs/how-to), [Identity Platform pricing](https://cloud.google.com/identity-platform/pricing)).
- Firestore's quoted daily free quota is correct: 50,000 reads, 20,000 writes, 20,000 deletes, 1 GiB stored data, and 10 GiB monthly outbound transfer. Only one database per project receives it; TTL deletes, PITR data, backups, restores, and clones are excluded ([Firestore pricing](https://firebase.google.com/docs/firestore/pricing)).
- Pub/Sub's first 10 GiB of basic publish/delivery throughput per billing account per month is free. After that, basic throughput is currently `$40/TiB` ([Pub/Sub pricing](https://cloud.google.com/pubsub/pricing)).
- The GKE `$74.40` monthly credit is real, but it offsets the `$0.10/hour` cluster-management fee only; it does not offset Autopilot Pod compute ([GKE pricing](https://cloud.google.com/kubernetes-engine/pricing)).
- The bootstrap island is real. Crossplane cannot create the cluster that hosts its own control plane. Keeping project/billing, APIs, network, cluster, identity bootstrap, and initial Crossplane/Flux installation in a small OpenTofu or scripted layer is reasonable.
- GKE Autopilot always has Workload Identity Federation for GKE enabled, so keyless workload credentials are the correct default ([Workload Identity Federation for GKE](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/workload-identity)).

## Required corrections

### 1. Treat the budget as a scenario, not a ceiling

Current default us-central1 Autopilot Pod-based rates are `$0.0445/vCPU-hour` and `$0.0049225/GiB-hour`. Therefore the proposed aggregate limit of 3.3 vCPU and 7 GiB costs approximately:

```text
(3.3 * $0.0445 + 7 * $0.0049225) * 744 hours = $134.89/month
```

That is Pod CPU and memory alone. One external load-balancer forwarding-rule tier adds about `$18.60/month` (`$0.025/hour`), and a small Cloud Armor Standard policy is roughly `$7-$10/month` before request fees. This already puts the capped workload near `$161-$164/month` before ephemeral storage, internet egress, load-balancer data processing, Firestore, Pub/Sub fan-out, logs, secrets, registry, backups, or retained traces ([GKE pricing](https://cloud.google.com/kubernetes-engine/pricing), [load-balancing pricing](https://cloud.google.com/load-balancing/pricing), [Cloud Armor pricing](https://cloud.google.com/armor/pricing)).

Autopilot also adds default requests when they are omitted and raises requests that violate minimums or CPU-to-memory ratios. Every container, including Crossplane providers and Flux controllers, needs an explicit request and a post-admission audit of the requests GKE actually accepted ([Autopilot resource requests](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-resource-requests)).

HPA maximums cap replicas, not total spend. Traffic-dependent Pub/Sub delivery, Firestore reads/listeners, network egress, Cloud Armor requests, load-balancer processing, and logging can all grow while replicas remain fixed. Ordinary Cloud Billing budgets remain alerts only. Google now has preview spend-cap budgets, but their documented eligible-service list does not include GKE, Firestore, Pub/Sub, or networking, and persistent resources can continue to accrue cost ([budget alerts](https://docs.cloud.google.com/billing/docs/how-to/budgets), [preview spend caps](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps)).

**Correction:** keep `$120-$200` only as a provisional low-volume forecast. Build a bill of materials from admitted Pod requests plus explicit events/second, bytes/event, subscriptions, viewers, reconnect rate, retention, egress, and log volume. Add service quotas and application rate limits as safety controls, not as a claim of a hard dollar cap.

### 2. Do not rely on the Cloudflare Crossplane provider yet

The old `crossplane-contrib/provider-cloudflare` repository was archived on 2026-03-06 and recommends `provider-upjet-cloudflare`. However, the proposed replacement's own README calls it a "starting point for generating a new Crossplane Provider." As of this review its repository exposes no tags or releases, so there is no published version to pin and no clear supported-release contract ([archived provider](https://github.com/crossplane-contrib/provider-cloudflare), [Upjet Cloudflare provider](https://github.com/crossplane-contrib/provider-upjet-cloudflare)).

By contrast, the official Cloudflare Terraform provider has versioned releases and current resource documentation ([official Cloudflare Terraform provider](https://registry.terraform.io/providers/cloudflare/cloudflare)).

**Correction:** leave Cloudflare DNS and zone settings in the OpenTofu bootstrap using the official Cloudflare provider. Reconsider Crossplane ownership only after a pinned-package install test proves the exact DNS/zone CRDs, reconciliation, upgrade, import, deletion/orphan, and rollback paths. Use a narrowly scoped Cloudflare API token either way.

The cited GCP provider-family version (`v2.6.2`) is also not a timeless choice. Current Upbound packages have moved on (for example, the Identity Platform provider is at `v3.0.1` in this review). Pin a tested, mutually compatible Crossplane/provider set in source control rather than embedding a version in the architecture narrative ([current Identity Platform provider package](https://marketplace.upbound.io/providers/upbound/provider-gcp-identityplatform/v3.0.1)).

### 3. Specify Pub/Sub fan-out, ordering, and idempotency

An ordering key is not a routing key. Attributes can be used by subscription filters for routing, while an ordering key only requests ordered delivery for messages sharing that key. Ordering must be enabled on each subscription; publishes for a key must enter the same region; ordering reduces availability/increases latency; and one hot `mesh_id` can serialize processing and build backlog ([Pub/Sub message model](https://docs.cloud.google.com/pubsub/docs/publish-message-overview), [ordered delivery](https://docs.cloud.google.com/pubsub/docs/ordering)).

Multiple subscriber processes sharing one subscription receive load-balanced subsets of messages, not a copy each. Thus horizontally scaled topology-stream Pods cannot each reconstruct the entire topology from one subscription. Every independent consumer group needs its own subscription, or one topology materializer must consume the stream and publish a separate fan-out/current-state projection. Each additional subscription also multiplies delivery throughput charges. Filtered-out messages still incur delivery throughput fees ([Pub/Sub basics](https://docs.cloud.google.com/pubsub/docs/pubsub-basics), [Pub/Sub filtered-message pricing](https://cloud.google.com/pubsub/pricing)).

Pub/Sub's default is at-least-once delivery, so topology updates and retained traces need stable event IDs and idempotent processing. Dead-letter forwarding is best effort; enabling it alongside ordering can weaken the expected order ([Pub/Sub ordering](https://docs.cloud.google.com/pubsub/docs/ordering)).

**Correction:** define one durable event envelope (`event_id`, `mesh_id`, `agent_id`, type, schema version, occurred/received timestamps), subscription-per-consumer-group semantics, deduplication, retry/DLQ behavior, replay/snapshot recovery, and the exact bridge from the materialized topology to connected browser sessions. Keep external agents behind authenticated Meshr APIs; do not issue them raw Pub/Sub credentials when mesh authorization lives in Firestore.

### 4. Design WebSockets as reconnectable projections

WebSockets are supported through Cloudflare and Google external Application Load Balancers, but neither layer promises an immortal connection. A global external Application Load Balancer closes active WebSockets after 24 hours and idle sockets after the backend timeout; GKE's `GCPBackendPolicy.timeoutSec` defaults to 30 seconds. Cloudflare can terminate sockets during edge deploys and closes idle connections; it recommends application heartbeats. Its WAF inspects the initial upgrade request, not subsequent WebSocket frames ([Google load-balancer timeouts](https://docs.cloud.google.com/load-balancing/docs/https/request-distribution), [GKE Gateway timeout policy](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/configure-gateway-resources), [Cloudflare WebSockets](https://developers.cloudflare.com/network/websockets/)).

**Correction:** configure the backend timeout intentionally, send ping/pong heartbeats, use exponential reconnect with jitter, authenticate/authorize every connection, validate and limit every frame in the application, and resume from a versioned snapshot or cursor after reconnect.

### 5. Strengthen the Cloudflare-to-origin boundary

Proxied DNS plus a Cloud Armor default-deny policy that allows all current Cloudflare IPv4 and IPv6 origin ranges blocks ordinary direct access to the load-balancer IP. The ranges must be synchronized as code. Cloudflare itself classifies IP allowlisting as only "moderately secure" and notes that shared Cloudflare addresses are used for all proxied hostnames; IP source alone does not prove the request passed through Meshr's zone ([Cloudflare IP ranges](https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/), [origin protection](https://developers.cloudflare.com/fundamentals/security/protect-your-origin-server/)).

`Full (strict)` authenticates the GCP origin certificate to Cloudflare; it does not authenticate Cloudflare to the origin. Authenticated Origin Pulls adds client-certificate authentication, but the default Cloudflare certificate is shared and stricter zone/hostname certificates require deliberate configuration ([Authenticated Origin Pulls](https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/explanation/)).

**Correction:** at minimum combine source-IP allowlisting, exact `Host` checks, a default deny, automated IP-range updates, and an origin-secret header checked by Cloud Armor or the application. Prefer a zone/hostname-specific authenticated origin mechanism when practical. Use the direct source IP for the Cloudflare gate; trust `CF-Connecting-IP` for per-client controls only after that gate. Do not describe IP allowlisting alone as cryptographic bypass prevention.

### 6. Make authorization and credential storage explicit

Putting mesh RBAC in Firestore rather than Identity Platform custom claims is sensible, but the Control API must enforce it on every operation. Firestore server libraries bypass Firestore Security Rules and authenticate with IAM, so the rules are not the server-side mesh authorization layer ([Firestore server-client security](https://firebase.google.com/docs/firestore/security/rules-conditions#authentication)).

The proposed `agent_credentials` collection must not contain recoverable bearer credentials. Store credential IDs, scopes, status, rotation timestamps, and slow hashes where verification requires them; place small numbers of root/signing secrets in Secret Manager. Secret Manager charges per active version and access, so a secret per agent changes the cost model at scale ([Secret Manager pricing](https://cloud.google.com/secret-manager/pricing)).

Use separate least-privilege Kubernetes service accounts and Google service accounts for the Control API, ingest, topology materializer, trace writer, Crossplane provider groups, and Flux. Human and agent tokens need distinct issuers/audiences or an equally strong typed-principal contract, short lifetimes, rotation/revocation, and server-derived identity.

### 7. State the durability and availability boundary

One Autopilot cluster is a reasonable initial simplification, and Autopilot clusters are regional. That removes a zonal control-plane dependency but does not survive a whole-region outage. Application availability still requires at least two replicas where appropriate, topology spread, disruption budgets, and load/recovery tests ([regional GKE clusters](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/regional-clusters)).

Choose the Firestore location deliberately. A regional location near `us-central1` minimizes latency and cost; a multi-region location provides a different durability/availability profile. Enable and price PITR/backups if the product requires recovery, because those features are outside the free quota ([Firestore locations](https://firebase.google.com/docs/firestore/locations), [Firestore pricing](https://firebase.google.com/docs/firestore/pricing)).

Crossplane's desired state and credentials live in the cluster even though the managed cloud resources do not. Keep all reconstructable claims/compositions/provider configuration in Git, protect destructive resources with deliberate management/deletion policies, back up any non-Git cluster state, and rehearse rebuilding Crossplane/Flux and re-observing existing resources after cluster loss. Avoid two controllers owning the same load-balancer objects: Crossplane may create prerequisites such as a named static address, certificate map, and Armor policy, while the GKE Gateway controller owns the load balancer it generates.

## Minimum approval gate

Approve this architecture for implementation only after the repository contains:

- a per-workload request/replica bill of materials and current calculator estimate;
- a traffic model covering publish and delivery throughput, subscribers, browser fan-out, egress, retention, Firestore operations, and logging;
- an OpenTofu-owned Cloudflare plan, or a documented proof that a versioned Crossplane package passes install/reconcile/delete/rollback tests;
- a Pub/Sub consumer-group, idempotency, DLQ, materialization, replay, and WebSocket reconnect design;
- a per-service IAM matrix and a credential storage/rotation design;
- exact Gateway class, certificate attachment, Cloud Armor default-deny, Cloudflare-range synchronization, and origin-authentication configuration;
- Firestore location, index, TTL, backup/PITR, and restore decisions; and
- load, reconnect, zonal disruption, cluster rebuild, and managed-resource re-observation tests.

## Bottom line

The architecture is a credible first production target, but the current document overstates cost control and provider maturity and leaves important streaming semantics implicit. Keep the GKE/Firestore/Pub/Sub/Gateway shape, move Cloudflare management into the bootstrap layer for now, replace the single `$200` claim with a measured cost model, and design Pub/Sub/WebSocket recovery before treating the plan as approved.
