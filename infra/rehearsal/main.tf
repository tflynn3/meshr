locals {
  name                 = "meshr-rehearsal"
  kubernetes_namespace = "meshr-rehearsal"

  # The provider must be able to turn these APIs on. They remain enabled when
  # this disposable foundation is destroyed so unrelated project bootstrap is
  # never torn down implicitly.
  required_services = toset([
    "artifactregistry.googleapis.com",
    "billingbudgets.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
    "container.googleapis.com",
    "firestore.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "pubsub.googleapis.com",
    "serviceusage.googleapis.com",
    "sts.googleapis.com",
  ])

  firestore_databases = {
    authority     = "${local.name}-authority"
    projections   = "${local.name}-projections"
    audit         = "${local.name}-audit"
    notifications = "${local.name}-notifications"
    moderation    = "${local.name}-moderation"
  }

  workload_accounts = {
    api = {
      account_id                 = "${local.name}-api"
      display_name               = "Meshr rehearsal API"
      kubernetes_service_account = "meshr-api"
    }
    bootstrap = {
      account_id                 = "${local.name}-bootstrap"
      display_name               = "Meshr rehearsal one-shot store bootstrap"
      kubernetes_service_account = "meshr-bootstrap"
    }
    ingest = {
      account_id                 = "${local.name}-ingest"
      display_name               = "Meshr rehearsal event ingest"
      kubernetes_service_account = "meshr-ingest"
    }
    topology = {
      account_id                 = "${local.name}-topology"
      display_name               = "Meshr rehearsal topology materializer"
      kubernetes_service_account = "meshr-topology-materializer"
    }
    live = {
      account_id                 = "${local.name}-live"
      display_name               = "Meshr rehearsal live gateway"
      kubernetes_service_account = "meshr-live-gateway"
    }
  }

  # Firestore IAM Conditions are database-scoped. No runtime identity receives
  # an unconditional Datastore role, and the presently unused audit,
  # notifications, and moderation databases receive no runtime grants.
  firestore_iam_grants = {
    api_authority = {
      account  = "api"
      database = "authority"
      role     = "roles/datastore.user"
    }
    api_projections = {
      account  = "api"
      database = "projections"
      role     = "roles/datastore.viewer"
    }
    bootstrap_authority = {
      account  = "bootstrap"
      database = "authority"
      role     = "roles/datastore.user"
    }
    bootstrap_projections = {
      account  = "bootstrap"
      database = "projections"
      role     = "roles/datastore.user"
    }
    topology_projections = {
      account  = "topology"
      database = "projections"
      role     = "roles/datastore.user"
    }
    live_projections = {
      account  = "live"
      database = "projections"
      role     = "roles/datastore.viewer"
    }
  }

  # These are the composite indexes exercised by the managed event-path and
  # restart proof. Emulators synthesize indexes automatically, so the GCP
  # rehearsal must own them explicitly or an otherwise green local smoke can
  # fail with FAILED_PRECONDITION in managed Firestore.
  firestore_indexes = {
    event_outbox_pending_created = {
      database   = "authority"
      collection = "event_outbox"
      fields = [
        { field_path = "status", order = "ASCENDING" },
        { field_path = "created_at", order = "ASCENDING" },
      ]
    }
    event_outbox_failed_retry = {
      database   = "authority"
      collection = "event_outbox"
      fields = [
        { field_path = "status", order = "ASCENDING" },
        { field_path = "next_attempt_at", order = "ASCENDING" },
      ]
    }
    event_outbox_mesh_status_created = {
      database   = "authority"
      collection = "event_outbox"
      fields = [
        { field_path = "mesh_id", order = "ASCENDING" },
        { field_path = "status", order = "ASCENDING" },
        { field_path = "created_at", order = "ASCENDING" },
      ]
    }
    event_outbox_ready_ordering_status_created = {
      database   = "authority"
      collection = "event_outbox_ready"
      fields = [
        { field_path = "ordering_key", order = "ASCENDING" },
        { field_path = "status", order = "ASCENDING" },
        { field_path = "created_at", order = "ASCENDING" },
      ]
    }
    event_outbox_ready_status_created = {
      database   = "authority"
      collection = "event_outbox_ready"
      fields = [
        { field_path = "status", order = "ASCENDING" },
        { field_path = "created_at", order = "ASCENDING" },
      ]
    }
    event_outbox_ready_status_created_desc = {
      database   = "authority"
      collection = "event_outbox_ready"
      fields = [
        { field_path = "status", order = "ASCENDING" },
        { field_path = "created_at", order = "DESCENDING" },
      ]
    }
    topology_activity_buckets_mesh_start = {
      database   = "projections"
      collection = "topology_activity_buckets"
      fields = [
        { field_path = "mesh_id", order = "ASCENDING" },
        { field_path = "bucket_start", order = "ASCENDING" },
      ]
    }
    topology_activity_buckets_compaction = {
      database   = "projections"
      collection = "topology_activity_buckets"
      fields = [
        { field_path = "recent_compacted_at", order = "ASCENDING" },
        { field_path = "bucket_start", order = "ASCENDING" },
        { field_path = "__name__", order = "ASCENDING" },
      ]
    }
  }

  github_repository = "tflynn3/meshr"
  # GitHub repositories created after 2026-07-15 use an immutable default OIDC
  # subject. Keep the human-readable names for workflow_ref while pinning the
  # security-sensitive subject to the non-reusable owner and repository IDs.
  github_immutable_subject_prefix = (
    "repo:tflynn3@${var.github_repository_owner_id}/meshr@${var.github_repository_id}"
  )
  github_workflow_ref_prefix = (
    "${local.github_repository}/.github/workflows/gcp-rehearsal.yml@refs/heads/"
  )
}

# Keep the externally selected billing context visible in state and plans
# without making this stack the owner of the project or its billing link.
resource "terraform_data" "billing_context" {
  input = {
    project_id         = var.project_id
    billing_account_id = var.billing_account_id
  }
}

data "google_project" "rehearsal" {
  project_id = var.project_id
}

resource "google_project_service" "required" {
  for_each = local.required_services

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# Budgets are notification thresholds, not enforcement. The ephemeral-cluster
# cleanup remains the mechanism that prevents overnight GKE spend.
resource "google_billing_budget" "rehearsal" {
  billing_account = var.billing_account_id
  display_name    = "Meshr rehearsal monthly alert"

  budget_filter {
    projects = ["projects/${data.google_project.rehearsal.number}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.monthly_budget_usd)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
    spend_basis       = "CURRENT_SPEND"
  }

  threshold_rules {
    threshold_percent = 0.9
    spend_basis       = "CURRENT_SPEND"
  }

  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "CURRENT_SPEND"
  }

  depends_on = [google_project_service.required]
}

resource "google_artifact_registry_repository" "images" {
  project       = var.project_id
  location      = var.region
  repository_id = local.name
  description   = "Short-retention OCI images for private Meshr deployment rehearsals."
  format        = "DOCKER"

  cleanup_policy_dry_run = false

  cleanup_policies {
    id     = "delete-images-older-than-seven-days"
    action = "DELETE"

    condition {
      tag_state  = "ANY"
      older_than = "604800s"
    }
  }

  cleanup_policies {
    id     = "keep-five-recent-versions"
    action = "KEEP"

    most_recent_versions {
      keep_count = 5
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_firestore_database" "database" {
  for_each = local.firestore_databases

  project                           = var.project_id
  name                              = each.value
  location_id                       = var.region
  type                              = "FIRESTORE_NATIVE"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_DISABLED"
  delete_protection_state           = "DELETE_PROTECTION_DISABLED"
  deletion_policy                   = "DELETE"

  depends_on = [google_project_service.required]
}

resource "google_firestore_index" "rehearsal" {
  for_each = local.firestore_indexes

  project    = var.project_id
  database   = google_firestore_database.database[each.value.database].name
  collection = each.value.collection

  dynamic "fields" {
    for_each = each.value.fields
    content {
      field_path = fields.value.field_path
      order      = fields.value.order
    }
  }
}

resource "google_pubsub_topic" "events" {
  project = var.project_id
  name    = "${local.name}-events"

  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }

  depends_on = [google_project_service.required]
}

resource "google_pubsub_subscription" "topology" {
  project = var.project_id
  name    = "${local.name}-topology"
  topic   = google_pubsub_topic.events.id

  ack_deadline_seconds       = 30
  enable_message_ordering    = true
  retain_acked_messages      = false
  message_retention_duration = "86400s"

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "300s"
  }

  # Do not let an idle but intentionally durable rehearsal foundation expire.
  expiration_policy {
    ttl = ""
  }
}

resource "google_service_account" "ci" {
  project      = var.project_id
  account_id   = "${local.name}-ci"
  display_name = "Meshr keyless rehearsal CI"

  depends_on = [google_project_service.required]
}

resource "google_service_account" "gke_nodes" {
  project      = var.project_id
  account_id   = "${local.name}-gke-nodes"
  display_name = "Meshr ephemeral rehearsal GKE nodes"

  depends_on = [google_project_service.required]
}

resource "google_service_account" "workload" {
  for_each = local.workload_accounts

  project      = var.project_id
  account_id   = each.value.account_id
  display_name = each.value.display_name

  depends_on = [google_project_service.required]
}

# Repository-level grants keep image push and pull permissions away from all
# other repositories in the project.
resource "google_artifact_registry_repository_iam_member" "ci_writer" {
  project    = var.project_id
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.ci.email}"
}

resource "google_artifact_registry_repository_iam_member" "gke_nodes_reader" {
  project    = var.project_id
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.gke_nodes.email}"
}

resource "google_project_iam_member" "gke_nodes_default_node" {
  project = var.project_id
  role    = "roles/container.defaultNodeServiceAccount"
  member  = "serviceAccount:${google_service_account.gke_nodes.email}"
}

# A dedicated rehearsal project is the resource boundary for cluster creation:
# GKE evaluates create on the project, so this cannot be scoped to a cluster
# that does not exist yet. The CI identity receives no Compute Admin or project
# Editor role.
resource "google_project_iam_member" "ci_container_admin" {
  project = var.project_id
  role    = "roles/container.admin"
  member  = "serviceAccount:${google_service_account.ci.email}"
}

resource "google_project_iam_member" "ci_service_usage" {
  project = var.project_id
  role    = "roles/serviceusage.serviceUsageConsumer"
  member  = "serviceAccount:${google_service_account.ci.email}"
}

resource "google_service_account_iam_member" "ci_act_as_gke_nodes" {
  service_account_id = google_service_account.gke_nodes.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.ci.email}"
}

# GKE's project-scoped Workload Identity pool survives deletion of the last
# cluster. The first rehearsal lifecycle established that pool; from then on,
# Terraform can own these exact, stable namespace/KSA-name bindings without
# giving deployment CI permission to rewrite workload service-account policy.
resource "google_service_account_iam_member" "workload_identity" {
  for_each = var.workload_identity_bindings_enabled ? local.workload_accounts : {}

  service_account_id = google_service_account.workload[each.key].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${local.kubernetes_namespace}/${each.value.kubernetes_service_account}]"
}

resource "google_project_iam_member" "firestore" {
  for_each = local.firestore_iam_grants

  project = var.project_id
  role    = each.value.role
  member  = "serviceAccount:${google_service_account.workload[each.value.account].email}"

  condition {
    title       = "rehearsal-${replace(each.key, "_", "-")}"
    description = "Restrict this workload grant to its single rehearsal Firestore database."
    expression  = "resource.name == 'projects/${var.project_id}/databases/${google_firestore_database.database[each.value.database].name}'"
  }
}

resource "google_pubsub_topic_iam_member" "ingest_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.events.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.workload["ingest"].email}"
}

# Publisher alone cannot perform the topic metadata check used by readiness;
# this viewer grant is still scoped to the single rehearsal topic.
resource "google_pubsub_topic_iam_member" "ingest_viewer" {
  project = var.project_id
  topic   = google_pubsub_topic.events.name
  role    = "roles/pubsub.viewer"
  member  = "serviceAccount:${google_service_account.workload["ingest"].email}"
}

resource "google_pubsub_subscription_iam_member" "topology_subscriber" {
  project      = var.project_id
  subscription = google_pubsub_subscription.topology.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.workload["topology"].email}"
}

# Subscriber permits message consumption but not subscriptions.get. The
# materializer readiness contract calls subscription.exists(), so grant the
# metadata read only on this one topology subscription.
resource "google_pubsub_subscription_iam_member" "topology_viewer" {
  project      = var.project_id
  subscription = google_pubsub_subscription.topology.name
  role         = "roles/pubsub.viewer"
  member       = "serviceAccount:${google_service_account.workload["topology"].email}"
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "meshr-rehearsal-github"
  display_name              = "Meshr rehearsal GitHub Actions"
  description               = "Keyless identity pool for the private ephemeral deployment rehearsal."

  depends_on = [google_project_service.required]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-rehearsal"
  display_name                       = "Meshr exact rehearsal workflow"

  attribute_mapping = {
    "google.subject"                = "assertion.sub"
    "attribute.repository_id"       = "assertion.repository_id"
    "attribute.repository_owner_id" = "assertion.repository_owner_id"
    "attribute.workflow_ref"        = "assertion.workflow_ref"
    "attribute.event_name"          = "assertion.event_name"
  }

  # Numeric identities survive repository/owner renames. The exact workflow
  # path may run from an authorized branch for a pre-merge deployment proof;
  # copies at any other workflow path cannot authenticate.
  attribute_condition = join(" ", [
    "assertion.repository_id == '${var.github_repository_id}' &&",
    "assertion.repository_owner_id == '${var.github_repository_owner_id}' &&",
    "assertion.sub == '${local.github_immutable_subject_prefix}:environment:gcp-rehearsal' &&",
    "assertion.workflow_ref.startsWith('${local.github_workflow_ref_prefix}') &&",
    "(assertion.event_name == 'workflow_dispatch' || assertion.event_name == 'schedule' ||",
    "(assertion.event_name == 'push' && assertion.ref == 'refs/heads/feat/copyable-agent-setup'))",
  ])

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "ci_workload_identity" {
  service_account_id = google_service_account.ci.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_id/${var.github_repository_id}"
}
