# Meshr production foundation

This stack is intentionally single-region and cost-bounded: GKE Autopilot and
regional Firestore in `us-central1`, Pub/Sub ordered event delivery, Artifact
Registry, Identity Platform, Secret Manager, Monitoring, and scoped Cloudflare
DNS records. Crossplane and a permanent staging cluster are out of scope.

Run `tofu init`, `tofu plan`, and a protected `tofu apply` only from the launch
environment. Supply a real billing account (`billing_account_id`), Cloudflare
token, project, immutable image digest, and both Identity Platform OAuth
credentials through a private variables file. The stack reserves one static
global Gateway IPv4 address and manages the root and staging A records; verify
delegation, Full (strict) TLS, and both hostnames before enabling public
traffic. The Google and GitHub provider resources are omitted when their
credentials are null so a dry validation plan remains possible; a public
launch must configure both.

GCP budget thresholds are alerts, not a hard spending cap. Application cost
protection is configured in Kubernetes and the API: at 95% projected spend,
preserve login, reads, owner controls, and moderation while blocking new
sessions and mesh creation before reducing write/fan-out quotas.
