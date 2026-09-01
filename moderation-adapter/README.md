# Meshr moderation adapter

This is the small, independently deployable boundary between Meshr's
moderation worker and Google Cloud safety services. It accepts a bounded,
authenticated `POST /screen` request and calls both Model Armor
`sanitizeUserPrompt` and Sensitive Data Protection `content:inspect`. It never
logs the post body, provider response, or access token.

The adapter is intentionally separate from the event-plane image. Its Cloud
Run service account is the only workload granted Model Armor and DLP
permissions; Meshr workers receive only Cloud Run invocation permission.

## Configuration

Production requires:

- `MESHR_ENV=production`
- `GOOGLE_CLOUD_PROJECT`
- `MESHR_MODEL_ARMOR_TEMPLATE=projects/.../locations/.../templates/...`
- optional `MESHR_MODEL_ARMOR_ENDPOINT` for a private/approved endpoint
- `MESHR_DLP_LOCATION` (required to be regional in production; the adapter
  derives `https://dlp.<location>.rep.googleapis.com` so content and the parent
  use the same region)
- `MESHR_MODERATION_RELEASE_SHA` (required in production as the exact
  lowercase 40-hex source commit baked into the adapter image)

The container obtains a short-lived access token from the Cloud Run metadata
server. `MESHR_ADAPTER_ACCESS_TOKEN` is accepted only for local tests. Cloud
Run IAM protects `/health`, `/healthz`, `/readyz`, and `/screen`; the
application also requires a Bearer header for those routes in production.

The worker should point `MESHR_MODERATION_ENDPOINT` and its health URL at the
exact `/screen` and `/health` paths of a verified no-traffic Cloud Run
revision tag. `MESHR_MODERATION_REVISION_TAG` is `r-` plus the first 20 hex
characters of the full `MESHR_MODERATION_RELEASE_SHA` for production. The
longer canary service name uses the first 14 so Cloud Run's deterministic tagged DNS label
stays within 63 characters. Either shortened value is only a routing label;
the full SHA health witness remains authoritative. The non-`z` `/health` path
is the Cloud Run contract; `/healthz` and `/readyz` remain compatibility
aliases for transports that do not reserve those paths. Keep the stable Cloud
Run service URI as the ID-token audience even when calling the tag URL. A
provider outage returns `503`, so the caller retries or DLQs the case rather
than acknowledging it as allowed.
Successful authenticated `/health`, `/healthz`, and `/readyz` responses carry
that full `releaseSha` and contract-version header. Callers must verify both
before binding a tagged revision to a Kubernetes release tuple.

Readiness performs the same side-effect-free Model Armor and DLP screening
operations used for posts against a fixed health-check sentinel. Screening
payloads are bounded to Meshr's 1,200-character post limit and no content is
written by this service. Every Model Armor request enables multi-language
detection. A Model Armor `PARTIAL` or `FAILURE` invocation is a provider error,
never an allow decision.
