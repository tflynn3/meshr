locals {
  name = "meshr"
  services = toset([
    "artifactregistry.googleapis.com",
    "apikeys.googleapis.com",
    "compute.googleapis.com",
    "container.googleapis.com",
    "certificatemanager.googleapis.com",
    "firestore.googleapis.com",
    "identitytoolkit.googleapis.com",
    "monitoring.googleapis.com",
    "pubsub.googleapis.com",
    "secretmanager.googleapis.com",
  ])
  event_subscriptions = {
    topology      = "topology-materializer"
    moderation    = "moderation-worker"
    audit         = "audit-worker"
    notifications = "notification-worker"
  }
}

resource "google_project_service" "required" {
  for_each           = local.services
  service            = each.value
  disable_on_destroy = false
}

resource "google_container_cluster" "autopilot" {
  name                = "${local.name}-autopilot"
  location            = var.region
  enable_autopilot    = true
  deletion_protection = true

  release_channel {
    channel = "REGULAR"
  }

  depends_on = [google_project_service.required]
}

resource "google_firestore_database" "default" {
  project     = var.project_id
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  delete_protection_state           = "DELETE_PROTECTION_ENABLED"
  depends_on                        = [google_project_service.required]
}

resource "google_pubsub_topic" "events" {
  name = "mesh-events"
  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }
  depends_on = [google_project_service.required]
}

resource "google_pubsub_topic" "dead_letter" {
  name       = "mesh-events-dlq"
  depends_on = [google_project_service.required]
}

resource "google_pubsub_subscription" "workers" {
  for_each = local.event_subscriptions
  name     = each.value
  topic    = google_pubsub_topic.events.id

  enable_message_ordering    = true
  ack_deadline_seconds       = 30
  retain_acked_messages      = true
  message_retention_duration = "86400s"

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter.id
    max_delivery_attempts = 10
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}

# Firestore creates single-field indexes automatically. These compound
# indexes back the atomic session-supersession and grant-revocation queries
# used by every API replica.
resource "google_firestore_index" "runtime_sessions_agent_status" {
  project    = var.project_id
  database   = "(default)"
  collection = "runtime_sessions"
  fields {
    field_path = "agent_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "mesh_memberships_agent_status" {
  project    = var.project_id
  database   = "(default)"
  collection = "mesh_agent_memberships"
  fields {
    field_path = "agent_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "meshes_visibility_lifecycle" {
  project    = var.project_id
  database   = "(default)"
  collection = "meshes"
  fields {
    field_path = "visibility"
    order      = "ASCENDING"
  }
  fields {
    field_path = "lifecycle"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "mesh_roles_mesh_role" {
  project    = var.project_id
  database   = "(default)"
  collection = "mesh_human_roles"
  fields {
    field_path = "mesh_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "role"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "webmcp_grants_agent_revoked" {
  project    = var.project_id
  database   = "(default)"
  collection = "webmcp_grants"
  fields {
    field_path = "agent_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "revoked_at"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "webmcp_grants_agent_session_revoked" {
  project    = var.project_id
  database   = "(default)"
  collection = "webmcp_grants"
  fields {
    field_path = "agent_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "session_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "revoked_at"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "webmcp_grants_human_revoked" {
  project    = var.project_id
  database   = "(default)"
  collection = "webmcp_grants"
  fields {
    field_path = "human_session_hash"
    order      = "ASCENDING"
  }
  fields {
    field_path = "revoked_at"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "posts_projection" {
  project    = var.project_id
  database   = "(default)"
  collection = "posts"
  fields {
    field_path = "mesh_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "moderation_state"
    order      = "ASCENDING"
  }
  fields {
    field_path = "expires_at"
    order      = "ASCENDING"
  }
  fields {
    field_path = "created_at"
    order      = "DESCENDING"
  }
}

resource "google_firestore_index" "pairings_agent_status" {
  project    = var.project_id
  database   = "(default)"
  collection = "pairings"
  fields {
    field_path = "agent_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "mesh_memberships_mesh_status" {
  project    = var.project_id
  database   = "(default)"
  collection = "mesh_agent_memberships"
  fields {
    field_path = "mesh_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "mesh_memberships_mesh_status_agent" {
  project    = var.project_id
  database   = "(default)"
  collection = "mesh_agent_memberships"
  fields {
    field_path = "mesh_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
  fields {
    field_path = "agent_id"
    order      = "ASCENDING"
  }
}

# Firestore TTL is the backstop for retention. The application sweep remains
# useful for bounded local cleanup and metrics, but it must not be the only
# mechanism at launch traffic volumes.
resource "google_firestore_field" "posts_expiry_ttl" {
  project    = var.project_id
  database   = "(default)"
  collection = "posts"
  field      = "expires_at"
  ttl_config {}
}

resource "google_firestore_field" "idempotency_expiry_ttl" {
  project    = var.project_id
  database   = "(default)"
  collection = "idempotency"
  field      = "expires_at"
  ttl_config {}
}

resource "google_firestore_field" "event_outbox_ttl" {
  project    = var.project_id
  database   = "(default)"
  collection = "event_outbox"
  field      = "created_at"
  ttl_config {}
}

resource "google_firestore_field" "topology_trace_ttl" {
  project    = var.project_id
  database   = "(default)"
  collection = "topology_events"
  field      = "recorded_at"
  ttl_config {}
}

resource "google_firestore_field" "processed_event_ttl" {
  project    = var.project_id
  database   = "(default)"
  collection = "processed_events"
  field      = "processed_at"
  ttl_config {}
}

resource "google_firestore_field" "moderation_inbox_ttl" {
  project    = var.project_id
  database   = "(default)"
  collection = "moderation_inbox"
  field      = "queued_at"
  ttl_config {}
}

resource "google_firestore_field" "notification_outbox_ttl" {
  project    = var.project_id
  database   = "(default)"
  collection = "notification_outbox"
  field      = "created_at"
  ttl_config {}
}

resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = local.name
  description   = "Signed Meshr OCI images"
  format        = "DOCKER"
  depends_on    = [google_project_service.required]
}

resource "google_compute_security_policy" "cloud_armor" {
  name        = "meshr-cloud-armor"
  description = "Launch guardrails for public Meshr HTTP and WebSocket traffic."

  rule {
    action   = "throttle"
    priority = 1000
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = 600
        interval_sec = 60
      }
    }
    description = "Bound unauthenticated and abusive edge traffic per source IP."
  }

  rule {
    action   = "allow"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "Default allow; application authorization remains authoritative."
  }
}

resource "google_service_account" "api" {
  account_id   = "meshr-api"
  display_name = "Meshr API least-privilege runtime"
}

resource "google_service_account" "event_plane" {
  account_id   = "meshr-event-plane"
  display_name = "Meshr event plane least-privilege runtime"
}

resource "google_service_account" "ingest" {
  account_id   = "meshr-ingest"
  display_name = "Meshr event ingest least-privilege runtime"
}

resource "google_project_iam_member" "api_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "event_plane_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.event_plane.email}"
}

resource "google_project_iam_member" "event_plane_pubsub" {
  project = var.project_id
  role    = "roles/pubsub.subscriber"
  member  = "serviceAccount:${google_service_account.event_plane.email}"
}

resource "google_project_iam_member" "ingest_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.ingest.email}"
}

resource "google_pubsub_topic_iam_member" "ingest_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.events.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.ingest.email}"
}

# GKE Workload Identity links the namespaced service accounts in the
# production overlay to their least-privilege Google service accounts.
resource "google_service_account_iam_member" "api_workload_identity" {
  service_account_id = google_service_account.api.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[meshr/meshr-api]"
}

resource "google_service_account_iam_member" "event_plane_workload_identity" {
  service_account_id = google_service_account.event_plane.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[meshr/meshr-event-plane]"
}

resource "google_service_account_iam_member" "ingest_workload_identity" {
  service_account_id = google_service_account.ingest.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[meshr/meshr-ingest]"
}

resource "google_identity_platform_config" "default" {
  project = var.project_id
  authorized_domains = [
    var.zone_name,
    "staging.${var.zone_name}",
  ]
  sign_in {
    # Meshr deliberately keeps provider identities separate until the human
    # explicitly links both identities in the signed-in account.
    allow_duplicate_emails = true
  }
  depends_on = [google_project_service.required]
}

resource "google_apikeys_key" "identity_platform_web" {
  name         = "meshr-web"
  display_name = "Meshr Identity Platform browser key"
  project      = var.project_id
  restrictions {
    browser_key_restrictions {
      allowed_referrers = [
        "https://${var.zone_name}/*",
        "https://staging.${var.zone_name}/*",
      ]
    }
    api_targets {
      service = "identitytoolkit.googleapis.com"
    }
  }
  depends_on = [google_project_service.required]
}

resource "google_identity_platform_default_supported_idp_config" "google" {
  count         = var.google_oauth_client_id == null || var.google_oauth_client_secret == null ? 0 : 1
  project       = var.project_id
  idp_id        = "google.com"
  client_id     = var.google_oauth_client_id
  client_secret = var.google_oauth_client_secret
  enabled       = true
  depends_on    = [google_identity_platform_config.default]
}

resource "google_identity_platform_default_supported_idp_config" "github" {
  count         = var.github_oauth_client_id == null || var.github_oauth_client_secret == null ? 0 : 1
  project       = var.project_id
  idp_id        = "github.com"
  client_id     = var.github_oauth_client_id
  client_secret = var.github_oauth_client_secret
  enabled       = true
  depends_on    = [google_identity_platform_config.default]
}

resource "google_certificate_manager_dns_authorization" "meshr" {
  project    = var.project_id
  location   = "global"
  name       = "meshr-social"
  domain     = var.zone_name
  depends_on = [google_project_service.required]
}

# Certificate Manager publishes a DNS-01 record that must be visible through
# Cloudflare before the managed certificate can be issued. Keep this record
# DNS-only; proxying validation records prevents Certificate Manager from
# observing the challenge.
resource "cloudflare_record" "certificate_authorization" {
  zone_id = data.cloudflare_zone.meshr.id
  name    = google_certificate_manager_dns_authorization.meshr.dns_resource_record[0].name
  type    = google_certificate_manager_dns_authorization.meshr.dns_resource_record[0].type
  value   = google_certificate_manager_dns_authorization.meshr.dns_resource_record[0].data
  ttl     = 300
  proxied = false
}

resource "google_certificate_manager_certificate" "meshr" {
  project  = var.project_id
  location = "global"
  name     = "meshr-social"
  managed {
    domains = [
      var.zone_name,
      "staging.${var.zone_name}",
    ]
    dns_authorizations = [google_certificate_manager_dns_authorization.meshr.id]
  }
  depends_on = [cloudflare_record.certificate_authorization]
}

resource "google_certificate_manager_certificate_map" "meshr" {
  project = var.project_id
  name    = "meshr-social"
}

resource "google_certificate_manager_certificate_map_entry" "root" {
  project      = var.project_id
  name         = "meshr-social-root"
  map          = google_certificate_manager_certificate_map.meshr.name
  hostname     = var.zone_name
  certificates = [google_certificate_manager_certificate.meshr.id]
}

resource "google_certificate_manager_certificate_map_entry" "staging" {
  project      = var.project_id
  name         = "meshr-social-staging"
  map          = google_certificate_manager_certificate_map.meshr.name
  hostname     = "staging.${var.zone_name}"
  certificates = [google_certificate_manager_certificate.meshr.id]
}

# Reserve the Gateway address before the first deployment. DNS can therefore
# point at a stable target while the managed GKE Gateway is reconciled and
# during later Gateway rollouts.
resource "google_compute_global_address" "gateway" {
  project      = var.project_id
  name         = "meshr-gateway"
  address_type = "EXTERNAL"
  ip_version   = "IPV4"
}

resource "google_secret_manager_secret" "internal_token" {
  secret_id = "meshr-internal-token"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "api_internal_token" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.internal_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "event_plane_internal_token" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.internal_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.event_plane.email}"
}

resource "google_secret_manager_secret_iam_member" "ingest_internal_token" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.internal_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.ingest.email}"
}

data "cloudflare_zone" "meshr" {
  name = var.zone_name
}

resource "cloudflare_zone_settings_override" "tls" {
  zone_id = data.cloudflare_zone.meshr.id
  settings {
    ssl              = "strict"
    always_use_https = "on"
    min_tls_version  = "1.2"
  }
}

resource "cloudflare_record" "root" {
  zone_id = data.cloudflare_zone.meshr.id
  name    = "@"
  type    = "A"
  value   = google_compute_global_address.gateway.address
  ttl     = 300
  proxied = true
  comment = "Meshr public Gateway static address; verify Full (strict) TLS before enabling traffic."
}

resource "cloudflare_record" "staging" {
  zone_id = data.cloudflare_zone.meshr.id
  name    = "staging"
  type    = "A"
  value   = google_compute_global_address.gateway.address
  ttl     = 300
  proxied = true
  comment = "Meshr canary hostname on the shared static Gateway address; never a second permanent cluster."
}

resource "google_monitoring_alert_policy" "pubsub_backlog" {
  display_name = "Meshr Pub/Sub backlog"
  combiner     = "OR"
  conditions {
    display_name = "oldest unacked message"
    condition_threshold {
      filter          = "resource.type=\"pubsub_subscription\" metric.type=\"pubsub.googleapis.com/subscription/oldest_unacked_message_age\""
      comparison      = "COMPARISON_GT"
      threshold_value = 120
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }
}

resource "google_billing_budget" "launch" {
  count           = var.billing_account_id == null || trimspace(var.billing_account_id) == "" ? 0 : 1
  billing_account = var.billing_account_id
  display_name    = "Meshr launch budget"
  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.monthly_budget_usd)
    }
  }
  threshold_rules { threshold_percent = 0.5 }
  threshold_rules { threshold_percent = 0.75 }
  threshold_rules { threshold_percent = 0.9 }
}
