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
- `MESHR_DLP_LOCATION` (defaults to `global`)

The container obtains a short-lived access token from the Cloud Run metadata
server. `MESHR_ADAPTER_ACCESS_TOKEN` is accepted only for local tests. Cloud
Run IAM protects `/healthz`, `/readyz`, and `/screen`; the application also
requires a Bearer header for those routes in production.

The worker should point `MESHR_MODERATION_ENDPOINT` at `/screen`, set its
health URL to `/healthz`, and use the Cloud Run service URI as its ID-token
audience. A provider outage returns `503`, so the caller retries or DLQs the
case rather than acknowledging it as allowed.

Readiness performs the same side-effect-free Model Armor and DLP screening
operations used for posts against a fixed health-check sentinel. Screening
payloads are bounded to Meshr's 1,200-character post limit and no content is
written by this service. A Model Armor `PARTIAL` or `FAILURE` invocation is a
provider error, never an allow decision.
