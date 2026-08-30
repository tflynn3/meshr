locals {
  name = "meshr"
  services = toset([
    "artifactregistry.googleapis.com",
    "apikeys.googleapis.com",
    "billingbudgets.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
    "container.googleapis.com",
    "certificatemanager.googleapis.com",
    "dlp.googleapis.com",
    "firestore.googleapis.com",
    "identitytoolkit.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "monitoring.googleapis.com",
    "modelarmor.googleapis.com",
    "pubsub.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "securetoken.googleapis.com",
    "serviceusage.googleapis.com",
    "sts.googleapis.com",
  ])
  event_subscriptions = {
    topology      = "topology-materializer"
    moderation    = "moderation-worker"
    audit         = "audit-worker"
    notifications = "notification-worker"
  }
  # Runtime identities are split by workload so a live-gateway compromise
  # cannot publish events or mutate moderation/audit state.
  worker_accounts = {
    live_gateway = {
      account_id      = "meshr-live-gateway"
      kubernetes_name = "meshr-live-gateway"
      firestore_role  = "roles/datastore.viewer"
    }
    topology_materializer = {
      account_id      = "meshr-topology"
      kubernetes_name = "meshr-topology-materializer"
      firestore_role  = "roles/datastore.user"
    }
    moderation_worker = {
      account_id      = "meshr-moderation"
      kubernetes_name = "meshr-moderation-worker"
      firestore_role  = "roles/datastore.user"
    }
    moderation_screening_worker = {
      account_id      = "meshr-moderation-screening"
      kubernetes_name = "meshr-moderation-screening-worker"
      firestore_role  = "roles/datastore.user"
    }
    audit_worker = {
      account_id      = "meshr-audit"
      kubernetes_name = "meshr-audit-worker"
      firestore_role  = "roles/datastore.user"
    }
    notification_worker = {
      account_id      = "meshr-notifications"
      kubernetes_name = "meshr-notification-worker"
      firestore_role  = "roles/datastore.user"
    }
  }
  canary_worker_accounts = {
    live_gateway = {
      account_id      = "meshr-live-gateway-canary"
      kubernetes_name = "meshr-live-gateway-canary"
      firestore_role  = "roles/datastore.viewer"
    }
    topology_materializer = {
      account_id      = "meshr-topology-canary"
      kubernetes_name = "meshr-topology-materializer-canary"
      firestore_role  = "roles/datastore.user"
    }
    moderation_worker = {
      account_id      = "meshr-moderation-canary"
      kubernetes_name = "meshr-moderation-worker-canary"
      firestore_role  = "roles/datastore.user"
    }
    moderation_screening_worker = {
      account_id      = "meshr-moderation-screening-canary"
      kubernetes_name = "meshr-moderation-screening-worker-canary"
      firestore_role  = "roles/datastore.user"
    }
    audit_worker = {
      account_id      = "meshr-audit-canary"
      kubernetes_name = "meshr-audit-worker-canary"
      firestore_role  = "roles/datastore.user"
    }
    notification_worker = {
      account_id      = "meshr-notifications-canary"
      kubernetes_name = "meshr-notification-worker-canary"
      firestore_role  = "roles/datastore.user"
    }
  }
  worker_subscriptions = {
    topology_materializer = "topology"
    moderation_worker     = "moderation"
    audit_worker          = "audit"
    notification_worker   = "notifications"
  }
  canary_worker_subscriptions = {
    topology_materializer = "topology"
    moderation_worker     = "moderation"
    audit_worker          = "audit"
    notification_worker   = "notifications"
  }
  # The named canary database receives the same compound indexes as the
  # production database. Keeping this map beside the production declarations
  # makes a new query's schema requirement visible in both environments.
  canary_firestore_indexes = {
    runtime_sessions_agent_status = {
      collection = "runtime_sessions"
      fields = [
        { field_path = "agent_id", order = "ASCENDING" },
        { field_path = "status", order = "ASCENDING" },
      ]
    }
    mesh_memberships_agent_status = {
      collection = "mesh_agent_memberships"
      fields = [
        { field_path = "agent_id", order = "ASCENDING" },
        { field_path = "status", order = "ASCENDING" },
      ]
    }
    meshes_visibility_lifecycle = {
      collection = "meshes"
      fields = [
        { field_path = "visibility", order = "ASCENDING" },
        { field_path = "lifecycle", order = "ASCENDING" },
      ]
    }
    meshes_owner_lifecycle = {
      collection = "meshes"
      fields = [
        { field_path = "owner_account_id", order = "ASCENDING" },
        { field_path = "lifecycle", order = "ASCENDING" },
      ]
    }
    mesh_roles_mesh_role = {
      collection = "mesh_human_roles"
      fields = [
        { field_path = "mesh_id", order = "ASCENDING" },
        { field_path = "role", order = "ASCENDING" },
      ]
    }
    mesh_roles_account_role = {
      collection = "mesh_human_roles"
      fields = [
        { field_path = "account_id", order = "ASCENDING" },
        { field_path = "role", order = "ASCENDING" },
      ]
    }
    mesh_role_invitations_mesh_status_expiry = {
      collection = "mesh_role_invitations"
      fields = [
        { field_path = "mesh_id", order = "ASCENDING" },
        { field_path = "status", order = "ASCENDING" },
        { field_path = "expires_at", order = "ASCENDING" },
      ]
    }
    mesh_invitations_mesh_status_expiry = {
      collection = "mesh_invitations"
      fields = [
        { field_path = "mesh_id", order = "ASCENDING" },
        { field_path = "status", order = "ASCENDING" },
        { field_path = "expires_at", order = "ASCENDING" },
      ]
    }
    webmcp_grants_agent_revoked = {
      collection = "webmcp_grants"
      fields = [
        { field_path = "agent_id", order = "ASCENDING" },
        { field_path = "revoked_at", order = "ASCENDING" },
      ]
    }
    webmcp_grants_agent_session_revoked = {
      collection = "webmcp_grants"
      fields = [
        { field_path = "agent_id", order = "ASCENDING" },
        { field_path = "session_id", order = "ASCENDING" },
        { field_path = "revoked_at", order = "ASCENDING" },
      ]
    }
    webmcp_grants_human_revoked = {
      collection = "webmcp_grants"
      fields = [
        { field_path = "human_session_hash", order = "ASCENDING" },
        { field_path = "revoked_at", order = "ASCENDING" },
      ]
    }
    posts_projection = {
      collection = "posts"
      fields = [
        { field_path = "mesh_id", order = "ASCENDING" },
        { field_path = "moderation_state", order = "ASCENDING" },
        { field_path = "expires_at", order = "DESCENDING" },
        { field_path = "created_at", order = "DESCENDING" },
      ]
    }
    posts_topic_created = {
      collection = "posts"
      fields = [
        { field_path = "topic_id", order = "ASCENDING" },
        { field_path = "moderation_state", order = "ASCENDING" },
        { field_path = "created_at", order = "ASCENDING" },
      ]
    }
    posts_topic_created_latest = {
      collection = "posts"
      fields = [
        { field_path = "topic_id", order = "ASCENDING" },
        { field_path = "moderation_state", order = "ASCENDING" },
        { field_path = "created_at", order = "DESCENDING" },
      ]
    }
    posts_expiry_pending = {
      collection = "posts"
      fields = [
        { field_path = "expiry_pending", order = "ASCENDING" },
        { field_path = "expires_at", order = "ASCENDING" },
      ]
    }
    moderation_cases_mesh_updated = {
      collection = "moderation_cases"
      fields = [
        { field_path = "mesh_id", order = "ASCENDING" },
        { field_path = "updated_at", order = "DESCENDING" },
        { field_path = "__name__", order = "DESCENDING" },
      ]
    }
    moderation_cases_mesh_state_updated = {
      collection = "moderation_cases"
      fields = [
        { field_path = "mesh_id", order = "ASCENDING" },
        { field_path = "state", order = "ASCENDING" },
        { field_path = "updated_at", order = "DESCENDING" },
        { field_path = "__name__", order = "DESCENDING" },
      ]
    }
    pairings_agent_status = {
      collection = "pairings"
      fields = [
        { field_path = "agent_id", order = "ASCENDING" },
        { field_path = "status", order = "ASCENDING" },
      ]
    }
    agent_bindings_agent_revoked = {
      collection = "agent_bindings"
      fields = [
        { field_path = "agent_id", order = "ASCENDING" },
        { field_path = "revoked_at", order = "ASCENDING" },
      ]
    }
    profile_review_proposals_agent_owner = {
      collection = "profile_review_proposals"
      fields = [
        { field_path = "agent_id", order = "ASCENDING" },
        { field_path = "owner_account_id", order = "ASCENDING" },
      ]
    }
    mesh_memberships_mesh_status = {
      collection = "mesh_agent_memberships"
      fields = [
        { field_path = "mesh_id", order = "ASCENDING" },
        { field_path = "status", order = "ASCENDING" },
      ]
    }
    mesh_memberships_mesh_status_agent = {
      collection = "mesh_agent_memberships"
      fields = [
        { field_path = "mesh_id", order = "ASCENDING" },
        { field_path = "status", order = "ASCENDING" },
        { field_path = "agent_id", order = "ASCENDING" },
      ]
    }
    mesh_memberships_pending_agent = {
      collection = "mesh_agent_memberships"
      fields = [
        { field_path = "mesh_id", order = "ASCENDING" },
        { field_path = "agent_id", order = "ASCENDING" },
        { field_path = "status", order = "ASCENDING" },
      ]
    }
    event_outbox_pending_created = {
      collection = "event_outbox"
      fields = [
        { field_path = "status", order = "ASCENDING" },
        { field_path = "created_at", order = "ASCENDING" },
      ]
    }
    event_outbox_failed_retry = {
      collection = "event_outbox"
      fields = [
        { field_path = "status", order = "ASCENDING" },
        { field_path = "next_attempt_at", order = "ASCENDING" },
      ]
    }
    event_outbox_mesh_status_created = {
      collection = "event_outbox"
      fields = [
        { field_path = "mesh_id", order = "ASCENDING" },
        { field_path = "status", order = "ASCENDING" },
        { field_path = "created_at", order = "ASCENDING" },
      ]
    }
    event_outbox_published_event = {
      collection = "event_outbox"
      fields = [
        { field_path = "published_at", order = "ASCENDING" },
        { field_path = "__name__", order = "ASCENDING" },
      ]
    }
    event_outbox_created_cursor = {
      collection = "event_outbox"
      fields = [
        { field_path = "created_at", order = "ASCENDING" },
        { field_path = "__name__", order = "ASCENDING" },
      ]
    }
    event_outbox_observation_scope_created_cursor = {
      collection = "event_outbox"
      fields = [
        { field_path = "observation_scope", order = "ASCENDING" },
        { field_path = "created_at", order = "ASCENDING" },
        { field_path = "__name__", order = "ASCENDING" },
      ]
    }
    event_outbox_mesh_created_cursor = {
      collection = "event_outbox"
      fields = [
        { field_path = "mesh_id", order = "ASCENDING" },
        { field_path = "created_at", order = "ASCENDING" },
        { field_path = "__name__", order = "ASCENDING" },
      ]
    }
    event_outbox_private_mesh_created_cursor = {
      collection = "event_outbox"
      fields = [
        { field_path = "observation_scope", order = "ASCENDING" },
        { field_path = "mesh_id", order = "ASCENDING" },
        { field_path = "created_at", order = "ASCENDING" },
        { field_path = "__name__", order = "ASCENDING" },
      ]
    }
    event_outbox_ready_ordering_status_created = {
      collection = "event_outbox_ready"
      fields = [
        { field_path = "ordering_key", order = "ASCENDING" },
        { field_path = "status", order = "ASCENDING" },
        { field_path = "created_at", order = "ASCENDING" },
      ]
    }
    event_outbox_ready_status_created = {
      collection = "event_outbox_ready"
      fields = [
        { field_path = "status", order = "ASCENDING" },
        { field_path = "created_at", order = "ASCENDING" },
      ]
    }
    event_outbox_ready_status_created_desc = {
      collection = "event_outbox_ready"
      fields = [
        { field_path = "status", order = "ASCENDING" },
        { field_path = "created_at", order = "DESCENDING" },
      ]
    }
    event_outbox_ready_shard_status_created = {
      collection = "event_outbox_ready"
      fields = [
        { field_path = "ready_shard", order = "ASCENDING" },
        { field_path = "status", order = "ASCENDING" },
        { field_path = "created_at", order = "ASCENDING" },
      ]
    }
    event_outbox_ready_shard_status_created_desc = {
      collection = "event_outbox_ready"
      fields = [
        { field_path = "ready_shard", order = "ASCENDING" },
        { field_path = "status", order = "ASCENDING" },
        { field_path = "created_at", order = "DESCENDING" },
      ]
    }
    moderation_inbox_due = {
      collection = "moderation_inbox"
      fields = [
        { field_path = "state", order = "ASCENDING" },
        { field_path = "available_at", order = "ASCENDING" },
      ]
    }
  }
  canary_firestore_ttl_fields = {
    idempotency_expiry       = { collection = "idempotency", field = "expires_at_ttl" }
    event_outbox             = { collection = "event_outbox", field = "retention_at" }
    event_outbox_ready       = { collection = "event_outbox_ready", field = "retention_at" }
    topology_events          = { collection = "topology_events", field = "retention_at" }
    processed_events         = { collection = "processed_events", field = "retention_at" }
    moderation_inbox         = { collection = "moderation_inbox", field = "retention_at" }
    moderation_dlq           = { collection = "moderation_dlq", field = "retention_at" }
    audit_events             = { collection = "audit_events", field = "retention_at" }
    moderation_cases         = { collection = "moderation_cases", field = "retention_at" }
    quota_counter            = { collection = "quota_counters", field = "expires_at_ttl" }
    pairing_expiry           = { collection = "pairings", field = "pending_expires_at_ttl" }
    pairing_challenge_expiry = { collection = "pairing_challenges", field = "expires_at_ttl" }
    mesh_invitation_expiry   = { collection = "mesh_invitations", field = "expires_at_ttl" }
    role_invitation_expiry   = { collection = "mesh_role_invitations", field = "expires_at_ttl" }
  }
  # Cloudflare is the only public edge for the proxied Gateway records. Keep
  # the origin closed to direct requests and rate-limit on the end-user IP
  # forwarded by Cloudflare. Reconcile this list with Cloudflare's published
  # ranges during the quarterly infrastructure review.
  cloudflare_edge_ipv4 = [
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
  ]
  # Cloud Armor accepts at most ten CIDRs in one SRC_IPS_V1 rule. Keep the
  # published Cloudflare ranges split into bounded sets so validation and
  # apply remain deterministic as the list is reviewed.
  cloudflare_edge_ipv4_primary = [
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
  ]
  cloudflare_edge_ipv4_secondary = [
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
  ]
  # Cloudflare's published IPv6 ranges are kept beside the IPv4 ranges so
  # dual-stack clients cannot bypass the same origin policy. Cloud Armor
  # accepts IPv4 and IPv6 CIDRs in SRC_IPS_V1 rules; keep the lists split so
  # each rule remains comfortably below the provider's ten-CIDR limit.
  cloudflare_edge_ipv6_primary = [
    "2400:cb00::/32",
    "2606:4700::/32",
    "2803:f800::/32",
    "2405:b500::/32",
  ]
  cloudflare_edge_ipv6_secondary = [
    "2405:8100::/32",
    "2a06:98c0::/29",
    "2c0f:f248::/32",
  ]
  # Validation plans can omit Cloudflare entirely. Any launch or explicitly
  # managed DNS apply turns this on and is guarded below so a missing token
  # cannot produce a partial public edge.
  cloudflare_enabled = var.launch_mode || var.manage_production_dns_records || var.manage_staging_dns_records
  # zone_name is validated as a DNS name, then normalized once for the
  # case-insensitive Cloud Armor Host comparison. Exact equality avoids a
  # hand-built regex whose escaping could drift when a different zone is
  # supplied to a validation or launch plan.
  edge_host_root     = lower(trimspace(var.zone_name))
  edge_host_staging  = "staging.${local.edge_host_root}"
  edge_origin_secret = try(trimspace(coalesce(var.cloudflare_origin_secret, "")), "")
}

data "google_project" "current" {
  project_id = var.project_id
}

locals {
  # Keep a no-credentials validation plan useful, but make the explicit launch
  # apply fail before it can create a partial public service without either
  # social provider or its spend alerts.
  launch_required_inputs = [
    try(trimspace(var.project_id), ""),
    try(trimspace(var.billing_account_id), ""),
    try(trimspace(var.google_oauth_client_id), ""),
    try(trimspace(var.google_oauth_client_secret), ""),
    try(trimspace(var.github_oauth_client_id), ""),
    try(trimspace(var.github_oauth_client_secret), ""),
    local.edge_origin_secret,
    try(trimspace(coalesce(var.moderation_adapter_image, "")), ""),
    try(trimspace(coalesce(var.moderation_adapter_canary_image, "")), ""),
    try(trimspace(coalesce(var.moderation_model_armor_template, "")), ""),
    try(trimspace(coalesce(var.alert_notification_email, "")), ""),
  ]
  # A restore is cut over by changing the protected Flux runtime ConfigMap to
  # one of these explicitly-authorized databases. Keeping the managed default
  # in the set means ordinary launch applies remain unchanged, while an
  # operator can authorize a restored database before switching traffic.
  authority_firestore_database_names = distinct(concat(
    [google_firestore_database.default.name],
    [for database_name in var.additional_authority_database_names : trimspace(database_name)],
  ))
  authority_firestore_iam_expression = join(" || ", [
    for database_name in local.authority_firestore_database_names :
    "resource.name == 'projects/${var.project_id}/databases/${database_name}'"
  ])
  # A point-in-time restore may be promoted by changing the protected runtime
  # value to a temporary topology database. Grant the read/write projection
  # workers that database before the cutover, then remove it after retirement.
  topology_firestore_database_names = distinct(concat(
    [google_firestore_database.projections.name],
    [for database_name in var.additional_topology_database_names : trimspace(database_name)],
  ))
  topology_firestore_iam_expression = join(" || ", [
    for database_name in local.topology_firestore_database_names :
    "resource.name == 'projects/${var.project_id}/databases/${database_name}'"
  ])
  # Restore allowlists are operator-controlled inputs. Fail closed if an
  # authority database is accidentally authorized for projection workers (or
  # vice versa); an IAM condition cannot repair an overlapping data boundary.
  firestore_database_allowlist_overlap = setintersection(
    toset(local.authority_firestore_database_names),
    toset(local.topology_firestore_database_names),
  )
  # These databases are managed by another trust boundary (release audit or
  # canary). A restore allowlist must never accidentally grant a production
  # worker access to one of them, even when the operator is changing only one
  # side of the authority/topology pair.
  firestore_cross_environment_database_names = toset([
    google_firestore_database.release_audit.name,
    google_firestore_database.audit.name,
    google_firestore_database.notifications.name,
    google_firestore_database.moderation.name,
    google_firestore_database.canary.name,
    google_firestore_database.canary_projections.name,
    google_firestore_database.canary_release_audit.name,
    google_firestore_database.canary_audit.name,
    google_firestore_database.canary_notifications.name,
    google_firestore_database.canary_moderation.name,
  ])
  firestore_cross_environment_restore_overlap = setintersection(
    toset(concat(
      [for database_name in var.additional_authority_database_names : trimspace(database_name)],
      [for database_name in var.additional_topology_database_names : trimspace(database_name)],
    )),
    local.firestore_cross_environment_database_names,
  )
  audit_firestore_iam_expression                = "resource.name == 'projects/${var.project_id}/databases/${google_firestore_database.audit.name}'"
  notifications_firestore_iam_expression        = "resource.name == 'projects/${var.project_id}/databases/${google_firestore_database.notifications.name}'"
  moderation_firestore_iam_expression           = "resource.name == 'projects/${var.project_id}/databases/${google_firestore_database.moderation.name}'"
  canary_topology_firestore_iam_expression      = "resource.name == 'projects/${var.project_id}/databases/${google_firestore_database.canary_projections.name}'"
  canary_audit_firestore_iam_expression         = "resource.name == 'projects/${var.project_id}/databases/${google_firestore_database.canary_audit.name}'"
  canary_notifications_firestore_iam_expression = "resource.name == 'projects/${var.project_id}/databases/${google_firestore_database.canary_notifications.name}'"
  canary_moderation_firestore_iam_expression    = "resource.name == 'projects/${var.project_id}/databases/${google_firestore_database.canary_moderation.name}'"
  monitoring_notification_channels = try(
    [google_monitoring_notification_channel.operations_email[0].name],
    [],
  )
}

resource "terraform_data" "firestore_database_separation_guard" {
  input = join(",", sort(tolist(local.firestore_database_allowlist_overlap)))

  lifecycle {
    precondition {
      condition     = length(local.firestore_database_allowlist_overlap) == 0
      error_message = "Authority and topology Firestore restore allowlists must be disjoint; remove overlapping database IDs before applying IAM grants."
    }
    precondition {
      condition     = length(local.firestore_cross_environment_restore_overlap) == 0
      error_message = "Firestore restore allowlists must not contain managed release-audit or canary database IDs; use an explicitly provisioned restore database instead."
    }
  }
}

resource "terraform_data" "launch_guard" {
  # Managing the production root record is itself a public-launch operation;
  # require the same complete credential, billing, and security preflight even
  # when an operator has not yet flipped launch_mode.
  count = var.launch_mode || var.manage_production_dns_records ? 1 : 0

  input = "public-launch"

  lifecycle {
    precondition {
      condition     = !(var.launch_mode || var.manage_production_dns_records) || var.accept_worker_authority_database_risk
      error_message = "launch_mode=true or manage_production_dns_records=true requires explicit accept_worker_authority_database_risk=true after the security owner reviews the database-scoped worker IAM boundary."
    }
    precondition {
      condition     = !(var.launch_mode || var.manage_production_dns_records) || var.accept_projection_marker_writer_risk
      error_message = "launch_mode=true or manage_production_dns_records=true requires explicit accept_projection_marker_writer_risk=true after the security owner reviews the topology marker-writer boundary, or a separately restricted attestation service/database."
    }
    precondition {
      condition = alltrue([
        for value in local.launch_required_inputs :
        trimspace(value) != ""
      ])
      error_message = "launch_mode=true or manage_production_dns_records=true requires project_id, billing_account_id, an operations alert email, both Google/GitHub OAuth client ID and secret values, immutable production and canary moderation adapter digests, and a Model Armor template resource. Leave both launch_mode and production DNS management disabled for validation plans."
    }
  }
}

resource "terraform_data" "cloudflare_guard" {
  count = local.cloudflare_enabled ? 1 : 0

  input = "cloudflare-edge"

  lifecycle {
    precondition {
      condition     = try(trimspace(var.cloudflare_api_token), "") != ""
      error_message = "launch_mode or DNS management requires cloudflare_api_token with Zone read, DNS edit, Zone Settings edit, Zone Transform Rules edit, and Account Rulesets read permissions."
    }
    precondition {
      condition     = local.edge_origin_secret != ""
      error_message = "launch_mode or DNS management requires cloudflare_origin_secret so Cloudflare-to-origin requests are authenticated beyond shared edge IP ranges."
    }
  }
}

resource "google_project_service" "required" {
  for_each           = local.services
  service            = each.value
  disable_on_destroy = false
}

resource "google_service_account" "gke_nodes" {
  account_id   = var.gke_node_service_account_id
  display_name = "Meshr GKE Autopilot node image-pull identity"
  depends_on   = [google_project_service.required]
}

resource "google_container_cluster" "autopilot" {
  name                = "${local.name}-autopilot"
  location            = var.region
  enable_autopilot    = true
  deletion_protection = true

  release_channel {
    channel = "REGULAR"
  }

  # Keep the Kubernetes control plane reachable only from fixed-egress
  # operators/runners. The variable is intentionally required: GitHub-hosted
  # runner ranges are dynamic and must not be copied into an allowlist.
  master_authorized_networks_config {
    dynamic "cidr_blocks" {
      for_each = var.gke_control_plane_authorized_cidrs
      content {
        cidr_block   = cidr_blocks.value.cidr_block
        display_name = cidr_blocks.value.display_name
      }
    }
    gcp_public_cidrs_access_enabled = false
  }

  # The production overlay uses the GKE-managed external GatewayClass. The
  # cluster must opt into the Gateway API channel before Flux reconciles the
  # Gateway resource, otherwise the class remains unavailable and the origin
  # has no supported TLS entry point.
  gateway_api_config {
    channel = "CHANNEL_STANDARD"
  }

  # Mount runtime credentials through GKE's managed Secret Manager CSI
  # component rather than storing long-lived values in Kubernetes Secrets.
  secret_manager_config {
    enabled = true
  }

  # Autopilot still needs an explicit node identity when pulling from the
  # private Artifact Registry. Keeping this in the cluster defaults avoids a
  # dependency on the project default compute service account.
  cluster_autoscaling {
    auto_provisioning_defaults {
      service_account = google_service_account.gke_nodes.email
      oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    }
  }

  depends_on = [
    google_project_service.required,
    google_project_iam_member.gke_nodes_default_node_service_account,
    google_artifact_registry_repository_iam_member.gke_nodes_images,
  ]
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

# Topology is an aggregate-only projection. Keeping it in its own database
# lets the public live gateway use a database-scoped read grant without any
# IAM path to accounts, sessions, posts, moderation, or audit records.
resource "google_firestore_database" "projections" {
  project                           = var.project_id
  name                              = "meshr-projections"
  location_id                       = var.region
  type                              = "FIRESTORE_NATIVE"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  delete_protection_state           = "DELETE_PROTECTION_ENABLED"
  depends_on                        = [google_project_service.required]
}

# Protected-release receipts live in their own database so a CI identity cannot
# read or mutate public production records. The release workflow selects this
# database through the explicit MESHR_AUDIT_FIRESTORE_DATABASE value.
resource "google_firestore_database" "release_audit" {
  project                           = var.project_id
  name                              = "meshr-release-audit"
  location_id                       = var.region
  type                              = "FIRESTORE_NATIVE"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  delete_protection_state           = "DELETE_PROTECTION_ENABLED"
  depends_on                        = [google_project_service.required]
}

# Event-worker delivery traces are intentionally separate from the authority
# database. The audit worker only needs the bounded `event_audit` trace and its
# processed-event ledger; keeping that state here makes its database-scoped IAM
# grant useful even if the worker process is compromised.
resource "google_firestore_database" "audit" {
  project                           = var.project_id
  name                              = "meshr-audit"
  location_id                       = var.region
  type                              = "FIRESTORE_NATIVE"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  delete_protection_state           = "DELETE_PROTECTION_ENABLED"
  depends_on                        = [google_project_service.required]
}

# Notifications are operational fan-out state, not authority. Keep it in a
# separate database so the notification worker cannot read accounts, posts,
# sessions, or governance records through its Firestore role.
resource "google_firestore_database" "notifications" {
  project                 = var.project_id
  name                    = "meshr-notifications"
  location_id             = var.region
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  depends_on              = [google_project_service.required]
}

# Moderation inbox leases and dead-letter references are worker-owned queue
# state, not authority. Isolating them means the screening process can never
# bypass the API's revision-fenced moderation route through a datastore grant.
resource "google_firestore_database" "moderation" {
  project                           = var.project_id
  name                              = "meshr-moderation"
  location_id                       = var.region
  type                              = "FIRESTORE_NATIVE"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  delete_protection_state           = "DELETE_PROTECTION_ENABLED"
  depends_on                        = [google_project_service.required]
}

# Canary runs in the same GKE cluster but uses a separate Firestore database
# so unapproved code cannot read or mutate public production records. The
# application selects this database only through the canary overlay's explicit
# MESHR_FIRESTORE_DATABASE value.
resource "google_firestore_database" "canary" {
  project                 = var.project_id
  name                    = "meshr-canary"
  location_id             = var.region
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  depends_on              = [google_project_service.required]
}

resource "google_firestore_database" "canary_projections" {
  project                 = var.project_id
  name                    = "meshr-canary-projections"
  location_id             = var.region
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  depends_on              = [google_project_service.required]
}

resource "google_firestore_database" "canary_release_audit" {
  project                           = var.project_id
  name                              = "meshr-canary-release-audit"
  location_id                       = var.region
  type                              = "FIRESTORE_NATIVE"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  delete_protection_state           = "DELETE_PROTECTION_ENABLED"
  depends_on                        = [google_project_service.required]
}

resource "google_firestore_database" "canary_audit" {
  project                           = var.project_id
  name                              = "meshr-canary-audit"
  location_id                       = var.region
  type                              = "FIRESTORE_NATIVE"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  delete_protection_state           = "DELETE_PROTECTION_ENABLED"
  depends_on                        = [google_project_service.required]
}

resource "google_firestore_database" "canary_notifications" {
  project                 = var.project_id
  name                    = "meshr-canary-notifications"
  location_id             = var.region
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  depends_on              = [google_project_service.required]
}

resource "google_firestore_database" "canary_moderation" {
  project                           = var.project_id
  name                              = "meshr-canary-moderation"
  location_id                       = var.region
  type                              = "FIRESTORE_NATIVE"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  delete_protection_state           = "DELETE_PROTECTION_ENABLED"
  depends_on                        = [google_project_service.required]
}

# Keep a rolling daily backup window in addition to point-in-time recovery.
# Restoration is still exercised into an isolated database before launch and
# quarterly thereafter; this resource only provisions the durable schedule.
resource "google_firestore_backup_schedule" "daily" {
  project   = var.project_id
  database  = google_firestore_database.default.name
  retention = "3024000s" # 35 days

  daily_recurrence {}
  depends_on = [google_firestore_database.default]
}

resource "google_firestore_backup_schedule" "projections_daily" {
  project   = var.project_id
  database  = google_firestore_database.projections.name
  retention = "3024000s" # 35 days

  daily_recurrence {}
  depends_on = [google_firestore_database.projections]
}

resource "google_firestore_backup_schedule" "release_audit_daily" {
  project   = var.project_id
  database  = google_firestore_database.release_audit.name
  retention = "3024000s" # 35 days

  daily_recurrence {}
  depends_on = [google_firestore_database.release_audit]
}

resource "google_firestore_backup_schedule" "moderation_daily" {
  project   = var.project_id
  database  = google_firestore_database.moderation.name
  retention = "3024000s" # 35 days

  daily_recurrence {}
  depends_on = [google_firestore_database.moderation]
}

resource "google_firestore_backup_schedule" "canary_release_audit_daily" {
  project   = var.project_id
  database  = google_firestore_database.canary_release_audit.name
  retention = "3024000s" # 35 days

  daily_recurrence {}
  depends_on = [google_firestore_database.canary_release_audit]
}

resource "google_firestore_backup_schedule" "canary_moderation_daily" {
  project   = var.project_id
  database  = google_firestore_database.canary_moderation.name
  retention = "3024000s" # 35 days

  daily_recurrence {}
  depends_on = [google_firestore_database.canary_moderation]
}

resource "google_firestore_field" "release_audit_events_ttl" {
  project    = var.project_id
  database   = google_firestore_database.release_audit.name
  collection = "audit_events"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "canary_release_audit_events_ttl" {
  project    = var.project_id
  database   = google_firestore_database.canary_release_audit.name
  collection = "audit_events"
  field      = "retention_at"
  ttl_config {}
}

resource "google_pubsub_topic" "events" {
  name = "mesh-events"
  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }
  depends_on = [google_project_service.required]
}

resource "google_pubsub_topic" "events_canary" {
  name = "mesh-events-canary"
  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }
  depends_on = [google_project_service.required]
}

resource "google_pubsub_topic" "dead_letter" {
  name       = "mesh-events-dlq"
  depends_on = [google_project_service.required]
}

resource "google_pubsub_topic" "dead_letter_canary" {
  name       = "mesh-events-canary-dlq"
  depends_on = [google_project_service.required]
}

# Moderation intake stores a durable inbox row, then publishes a separate
# screening job. Keeping this queue independent means its undelivered metric
# measures provider work rather than the short Firestore-enqueue transaction.
resource "google_pubsub_topic" "moderation_screening" {
  name = "moderation-screening"
  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }
  depends_on = [google_project_service.required]
}

resource "google_pubsub_topic" "moderation_screening_canary" {
  name = "moderation-screening-canary"
  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }
  depends_on = [google_project_service.required]
}

resource "google_pubsub_subscription" "dead_letter" {
  name                       = "mesh-events-dlq-replay"
  topic                      = google_pubsub_topic.dead_letter.id
  retain_acked_messages      = true
  message_retention_duration = "2592000s"
  ack_deadline_seconds       = 30
  depends_on                 = [google_pubsub_topic.dead_letter]
}

resource "google_pubsub_subscription" "dead_letter_canary" {
  name                       = "mesh-events-canary-dlq-replay"
  topic                      = google_pubsub_topic.dead_letter_canary.id
  retain_acked_messages      = true
  message_retention_duration = "2592000s"
  ack_deadline_seconds       = 30
  depends_on                 = [google_pubsub_topic.dead_letter_canary]
}

resource "google_pubsub_subscription" "workers" {
  for_each = local.event_subscriptions
  name     = each.value
  topic    = google_pubsub_topic.events.id

  enable_message_ordering = true
  ack_deadline_seconds    = 30
  retain_acked_messages   = true
  # Keep source events available through the documented 30-day raw delivery
  # window so a worker outage can be repaired without losing accepted writes.
  message_retention_duration = "2592000s"

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter.id
    max_delivery_attempts = 10
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}

resource "google_pubsub_subscription" "canary_workers" {
  for_each = {
    topology      = "topology-materializer-canary"
    moderation    = "moderation-worker-canary"
    audit         = "audit-worker-canary"
    notifications = "notification-worker-canary"
  }
  name  = each.value
  topic = google_pubsub_topic.events_canary.id

  enable_message_ordering    = true
  ack_deadline_seconds       = 30
  retain_acked_messages      = true
  message_retention_duration = "2592000s"

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter_canary.id
    max_delivery_attempts = 10
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
  depends_on = [google_pubsub_topic.dead_letter_canary]
}

resource "google_pubsub_subscription" "moderation_screening" {
  name  = "moderation-screening-worker"
  topic = google_pubsub_topic.moderation_screening.id

  enable_message_ordering    = true
  ack_deadline_seconds       = 30
  retain_acked_messages      = true
  message_retention_duration = "2592000s"

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter.id
    max_delivery_attempts = 10
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
  depends_on = [google_pubsub_topic.dead_letter]
}

resource "google_pubsub_subscription" "moderation_screening_canary" {
  name  = "moderation-screening-worker-canary"
  topic = google_pubsub_topic.moderation_screening_canary.id

  enable_message_ordering    = true
  ack_deadline_seconds       = 30
  retain_acked_messages      = true
  message_retention_duration = "2592000s"

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter_canary.id
    max_delivery_attempts = 10
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
  depends_on = [google_pubsub_topic.dead_letter_canary]
}

# Pub/Sub's service agent must be able to forward exhausted deliveries to the
# DLQ and acknowledge them on each source subscription. Without these grants
# a configured dead-letter policy silently behaves like an ordinary retry.
resource "google_pubsub_topic_iam_member" "dead_letter_service_agent" {
  project = var.project_id
  topic   = google_pubsub_topic.dead_letter.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription_iam_member" "dead_letter_service_agent" {
  for_each     = google_pubsub_subscription.workers
  project      = var.project_id
  subscription = each.value.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_topic_iam_member" "dead_letter_canary_service_agent" {
  project = var.project_id
  topic   = google_pubsub_topic.dead_letter_canary.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription_iam_member" "dead_letter_canary_service_agent" {
  for_each     = google_pubsub_subscription.canary_workers
  project      = var.project_id
  subscription = each.value.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription_iam_member" "dead_letter_screening_service_agent" {
  project      = var.project_id
  subscription = google_pubsub_subscription.moderation_screening.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription_iam_member" "dead_letter_screening_canary_service_agent" {
  project      = var.project_id
  subscription = google_pubsub_subscription.moderation_screening_canary.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

# Firestore creates single-field indexes automatically. These compound
# indexes back the atomic session-supersession and grant-revocation queries
# used by every API replica.
resource "google_firestore_index" "runtime_sessions_agent_status" {
  project    = var.project_id
  database   = google_firestore_database.default.name
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
  database   = google_firestore_database.default.name
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
  database   = google_firestore_database.default.name
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

resource "google_firestore_index" "meshes_owner_lifecycle" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "meshes"
  fields {
    field_path = "owner_account_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "lifecycle"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "mesh_roles_mesh_role" {
  project    = var.project_id
  database   = google_firestore_database.default.name
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

resource "google_firestore_index" "mesh_roles_account_role" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "mesh_human_roles"
  fields {
    field_path = "account_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "role"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "mesh_role_invitations_mesh_status_expiry" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "mesh_role_invitations"
  fields {
    field_path = "mesh_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
  fields {
    field_path = "expires_at"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "mesh_invitations_mesh_status_expiry" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "mesh_invitations"
  fields {
    field_path = "mesh_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
  fields {
    field_path = "expires_at"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "webmcp_grants_agent_revoked" {
  project    = var.project_id
  database   = google_firestore_database.default.name
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
  database   = google_firestore_database.default.name
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
  database   = google_firestore_database.default.name
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
  database   = google_firestore_database.default.name
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
    order      = "DESCENDING"
  }
  fields {
    field_path = "created_at"
    order      = "DESCENDING"
  }
}

resource "google_firestore_index" "posts_topic_created" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "posts"
  fields {
    field_path = "topic_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "moderation_state"
    order      = "ASCENDING"
  }
  fields {
    field_path = "created_at"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "posts_topic_created_latest" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "posts"
  fields {
    field_path = "topic_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "moderation_state"
    order      = "ASCENDING"
  }
  fields {
    field_path = "created_at"
    order      = "DESCENDING"
  }
}

resource "google_firestore_index" "posts_expiry_pending" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "posts"
  fields {
    field_path = "expiry_pending"
    order      = "ASCENDING"
  }
  fields {
    field_path = "expires_at"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "pairings_agent_status" {
  project    = var.project_id
  database   = google_firestore_database.default.name
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

resource "google_firestore_index" "agent_bindings_agent_revoked" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "agent_bindings"
  fields {
    field_path = "agent_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "revoked_at"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "profile_review_proposals_agent_owner" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "profile_review_proposals"
  fields {
    field_path = "agent_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "owner_account_id"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "mesh_memberships_mesh_status" {
  project    = var.project_id
  database   = google_firestore_database.default.name
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
  database   = google_firestore_database.default.name
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

resource "google_firestore_index" "mesh_memberships_pending_agent" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "mesh_agent_memberships"
  fields {
    field_path = "mesh_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "agent_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "event_outbox_pending_created" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "event_outbox"
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
  fields {
    field_path = "created_at"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "event_outbox_failed_retry" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "event_outbox"
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
  fields {
    field_path = "next_attempt_at"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "event_outbox_mesh_status_created" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "event_outbox"
  fields {
    field_path = "mesh_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
  fields {
    field_path = "created_at"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "event_outbox_published_event" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "event_outbox"
  fields {
    field_path = "published_at"
    order      = "ASCENDING"
  }
  fields {
    field_path = "__name__"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "event_outbox_created_cursor" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "event_outbox"
  fields {
    field_path = "created_at"
    order      = "ASCENDING"
  }
  fields {
    field_path = "__name__"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "event_outbox_observation_scope_created_cursor" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "event_outbox"
  fields {
    field_path = "observation_scope"
    order      = "ASCENDING"
  }
  fields {
    field_path = "created_at"
    order      = "ASCENDING"
  }
  fields {
    field_path = "__name__"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "event_outbox_mesh_created_cursor" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "event_outbox"
  fields {
    field_path = "mesh_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "created_at"
    order      = "ASCENDING"
  }
  fields {
    field_path = "__name__"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "event_outbox_private_mesh_created_cursor" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "event_outbox"
  fields {
    field_path = "observation_scope"
    order      = "ASCENDING"
  }
  fields {
    field_path = "mesh_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "created_at"
    order      = "ASCENDING"
  }
  fields {
    field_path = "__name__"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "moderation_inbox_due" {
  project    = var.project_id
  database   = google_firestore_database.moderation.name
  collection = "moderation_inbox"
  fields {
    field_path = "state"
    order      = "ASCENDING"
  }
  fields {
    field_path = "available_at"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "moderation_cases_mesh_updated" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "moderation_cases"
  fields {
    field_path = "mesh_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "updated_at"
    order      = "DESCENDING"
  }
  fields {
    field_path = "__name__"
    order      = "DESCENDING"
  }
}

resource "google_firestore_index" "moderation_cases_mesh_state_updated" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "moderation_cases"
  fields {
    field_path = "mesh_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "state"
    order      = "ASCENDING"
  }
  fields {
    field_path = "updated_at"
    order      = "DESCENDING"
  }
  fields {
    field_path = "__name__"
    order      = "DESCENDING"
  }
}

resource "google_firestore_index" "canary" {
  for_each   = local.canary_firestore_indexes
  project    = var.project_id
  database   = google_firestore_database.canary.name
  collection = each.value.collection
  dynamic "fields" {
    for_each = each.value.fields
    content {
      field_path = fields.value.field_path
      order      = fields.value.order
    }
  }
}

resource "google_firestore_index" "event_outbox_ready_ordering_status_created" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "event_outbox_ready"
  fields {
    field_path = "ordering_key"
    order      = "ASCENDING"
  }
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
  fields {
    field_path = "created_at"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "event_outbox_ready_status_created" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "event_outbox_ready"
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
  fields {
    field_path = "created_at"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "event_outbox_ready_status_created_desc" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "event_outbox_ready"
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
  fields {
    field_path = "created_at"
    order      = "DESCENDING"
  }
}

resource "google_firestore_index" "event_outbox_ready_shard_status_created" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "event_outbox_ready"
  fields {
    field_path = "ready_shard"
    order      = "ASCENDING"
  }
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
  fields {
    field_path = "created_at"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "event_outbox_ready_shard_status_created_desc" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "event_outbox_ready"
  fields {
    field_path = "ready_shard"
    order      = "ASCENDING"
  }
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
  fields {
    field_path = "created_at"
    order      = "DESCENDING"
  }
}

# Post retention is thread-aware and is enforced by the application sweep.
# Do not configure a per-document Firestore TTL for posts: a native TTL could
# delete a parent before a still-live reply, violating the retention contract.

resource "google_firestore_field" "idempotency_expiry_ttl" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "idempotency"
  field      = "expires_at_ttl"
  ttl_config {}
}

resource "google_firestore_field" "event_outbox_ttl" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "event_outbox"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "event_outbox_ready_ttl" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "event_outbox_ready"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "topology_trace_ttl" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "topology_events"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "processed_event_ttl" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "processed_events"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "moderation_processed_event_ttl" {
  project    = var.project_id
  database   = google_firestore_database.moderation.name
  collection = "processed_events"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "moderation_inbox_ttl" {
  project    = var.project_id
  database   = google_firestore_database.moderation.name
  collection = "moderation_inbox"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "moderation_dlq_ttl" {
  project    = var.project_id
  database   = google_firestore_database.moderation.name
  collection = "moderation_dlq"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "audit_events_ttl" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "audit_events"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "audit_event_trace_ttl" {
  project    = var.project_id
  database   = google_firestore_database.audit.name
  collection = "event_audit"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "audit_processed_event_ttl" {
  project    = var.project_id
  database   = google_firestore_database.audit.name
  collection = "processed_events"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "notification_outbox_ttl" {
  project    = var.project_id
  database   = google_firestore_database.notifications.name
  collection = "notification_outbox"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "notification_processed_event_ttl" {
  project    = var.project_id
  database   = google_firestore_database.notifications.name
  collection = "processed_events"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "moderation_cases_ttl" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "moderation_cases"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "quota_counter_ttl" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "quota_counters"
  field      = "expires_at_ttl"
  ttl_config {}
}

resource "google_firestore_field" "pairing_pending_expiry_ttl" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "pairings"
  field      = "pending_expires_at_ttl"
  ttl_config {}
}

resource "google_firestore_field" "pairing_challenge_expiry_ttl" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "pairing_challenges"
  field      = "expires_at_ttl"
  ttl_config {}
}

resource "google_firestore_field" "mesh_invitation_expiry_ttl" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "mesh_invitations"
  field      = "expires_at_ttl"
  ttl_config {}
}

resource "google_firestore_field" "mesh_role_invitation_expiry_ttl" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = "mesh_role_invitations"
  field      = "expires_at_ttl"
  ttl_config {}
}

resource "google_firestore_field" "topology_projection_trace_ttl" {
  project    = var.project_id
  database   = google_firestore_database.projections.name
  collection = "topology_events"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "topology_projection_processed_event_ttl" {
  project    = var.project_id
  database   = google_firestore_database.projections.name
  collection = "processed_events"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "topology_projection_activity_totals_ttl" {
  project    = var.project_id
  database   = google_firestore_database.projections.name
  collection = "topology_activity_totals"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "topology_projection_activity_buckets_ttl" {
  project    = var.project_id
  database   = google_firestore_database.projections.name
  collection = "topology_activity_buckets"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "topology_projection_activity_recent_ttl" {
  project    = var.project_id
  database   = google_firestore_database.projections.name
  collection = "topology_activity_recent"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "topology_projection_activity_snapshots_ttl" {
  project    = var.project_id
  database   = google_firestore_database.projections.name
  collection = "topology_activity_snapshots"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_index" "topology_projection_activity_buckets_mesh_start" {
  project    = var.project_id
  database   = google_firestore_database.projections.name
  collection = "topology_activity_buckets"
  fields {
    field_path = "mesh_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "bucket_start"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "topology_projection_activity_buckets_compaction" {
  project    = var.project_id
  database   = google_firestore_database.projections.name
  collection = "topology_activity_buckets"
  fields {
    field_path = "recent_compacted_at"
    order      = "ASCENDING"
  }
  fields {
    field_path = "bucket_start"
    order      = "ASCENDING"
  }
  fields {
    field_path = "__name__"
    order      = "ASCENDING"
  }
}

resource "google_firestore_field" "canary_ttl" {
  for_each   = local.canary_firestore_ttl_fields
  project    = var.project_id
  database   = google_firestore_database.canary.name
  collection = each.value.collection
  field      = each.value.field
  ttl_config {}
}

resource "google_firestore_field" "canary_audit_event_trace_ttl" {
  project    = var.project_id
  database   = google_firestore_database.canary_audit.name
  collection = "event_audit"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "canary_audit_processed_event_ttl" {
  project    = var.project_id
  database   = google_firestore_database.canary_audit.name
  collection = "processed_events"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "canary_notification_outbox_ttl" {
  project    = var.project_id
  database   = google_firestore_database.canary_notifications.name
  collection = "notification_outbox"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "canary_notification_processed_event_ttl" {
  project    = var.project_id
  database   = google_firestore_database.canary_notifications.name
  collection = "processed_events"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "canary_topology_projection_trace_ttl" {
  project    = var.project_id
  database   = google_firestore_database.canary_projections.name
  collection = "topology_events"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "canary_topology_projection_processed_event_ttl" {
  project    = var.project_id
  database   = google_firestore_database.canary_projections.name
  collection = "processed_events"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "canary_topology_projection_activity_totals_ttl" {
  project    = var.project_id
  database   = google_firestore_database.canary_projections.name
  collection = "topology_activity_totals"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "canary_topology_projection_activity_buckets_ttl" {
  project    = var.project_id
  database   = google_firestore_database.canary_projections.name
  collection = "topology_activity_buckets"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "canary_topology_projection_activity_recent_ttl" {
  project    = var.project_id
  database   = google_firestore_database.canary_projections.name
  collection = "topology_activity_recent"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_field" "canary_topology_projection_activity_snapshots_ttl" {
  project    = var.project_id
  database   = google_firestore_database.canary_projections.name
  collection = "topology_activity_snapshots"
  field      = "retention_at"
  ttl_config {}
}

resource "google_firestore_index" "canary_topology_projection_activity_buckets_mesh_start" {
  project    = var.project_id
  database   = google_firestore_database.canary_projections.name
  collection = "topology_activity_buckets"
  fields {
    field_path = "mesh_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "bucket_start"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "canary_topology_projection_activity_buckets_compaction" {
  project    = var.project_id
  database   = google_firestore_database.canary_projections.name
  collection = "topology_activity_buckets"
  fields {
    field_path = "recent_compacted_at"
    order      = "ASCENDING"
  }
  fields {
    field_path = "bucket_start"
    order      = "ASCENDING"
  }
  fields {
    field_path = "__name__"
    order      = "ASCENDING"
  }
}

resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = local.name
  description   = "Signed Meshr OCI images"
  format        = "DOCKER"
  depends_on    = [google_project_service.required]
}

resource "google_artifact_registry_repository_iam_member" "gke_nodes_images" {
  project    = var.project_id
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.gke_nodes.email}"
}

resource "google_compute_security_policy" "cloud_armor" {
  name        = "meshr-cloud-armor"
  description = "Launch guardrails for public Meshr HTTP and WebSocket traffic."
  depends_on  = [google_project_service.required]

  advanced_options_config {
    user_ip_request_headers = ["CF-Connecting-IP"]
  }

  rule {
    action   = "throttle"
    priority = 1000
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = local.cloudflare_edge_ipv4_primary
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "USER_IP"
      rate_limit_threshold {
        # This edge guard must sit above the authenticated application budget:
        # one account may have 25 agents (1,500 posts/minute), and a shared
        # viewer NAT can add reads and WebSocket reconnects. Application-level
        # quotas remain the authoritative per-agent/global write controls.
        count        = 12000
        interval_sec = 60
      }
    }
    description = "Bound unauthenticated and abusive edge traffic per source IP."
  }

  rule {
    action   = "throttle"
    priority = 1001
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = local.cloudflare_edge_ipv4_secondary
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "USER_IP"
      rate_limit_threshold {
        count        = 12000
        interval_sec = 60
      }
    }
    description = "Bound unauthenticated and abusive edge traffic per source IP (continued range set)."
  }

  rule {
    action   = "throttle"
    priority = 1002
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = local.cloudflare_edge_ipv6_primary
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "USER_IP"
      rate_limit_threshold {
        count        = 12000
        interval_sec = 60
      }
    }
    description = "Bound dual-stack edge traffic per source IPv6 range."
  }

  rule {
    action   = "throttle"
    priority = 1003
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = local.cloudflare_edge_ipv6_secondary
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "USER_IP"
      rate_limit_threshold {
        count        = 12000
        interval_sec = 60
      }
    }
    description = "Bound dual-stack edge traffic per source IPv6 range (continued set)."
  }

  # Health checks are authorized before the hostname guard because Google's
  # checker may use the backend address as Host. Every user-facing request
  # still has to name one of the two Gateway listeners below.
  rule {
    action   = "allow"
    priority = 110
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["35.191.0.0/16", "130.211.0.0/22"]
      }
    }
    description = "Allow Google load-balancer health checks before host filtering."
  }

  rule {
    action   = "deny(403)"
    priority = 120
    match {
      expr {
        # Cloud Armor normalizes header names to lowercase. Exact equality
        # avoids trusting a shared Cloudflare source IP as proof that the
        # request traversed this zone; Cloudflare's transform rule below
        # overwrites this header on both Meshr hostnames.
        expression = local.edge_origin_secret == "" ? "false" : "!has(request.headers['x-meshr-origin-secret']) || request.headers['x-meshr-origin-secret'] != '${local.edge_origin_secret}'"
      }
    }
    description = "Reject requests missing the zone-specific Cloudflare origin secret."
  }

  rule {
    action   = "deny(403)"
    priority = 121
    match {
      expr {
        # Keep the listener comparison case-insensitive and explicit. The
        # zone_name variable is DNS-name validated before interpolation.
        expression = "!(request.headers['host'].lower() == '${local.edge_host_root}' || request.headers['host'].lower() == '${local.edge_host_staging}' || request.headers['host'].lower() == '${local.edge_host_root}:443' || request.headers['host'].lower() == '${local.edge_host_staging}:443')"
      }
    }
    description = "Reject requests whose Host is not a Meshr Gateway listener."
  }

  # Any source that is neither a Cloudflare edge nor a Google health checker
  # reaches this terminal deny, including direct requests to the reserved IP.
  rule {
    action   = "deny(403)"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "Reject direct-to-origin traffic outside Cloudflare and health checks."
  }
}

resource "google_service_account" "api" {
  account_id   = "meshr-api"
  display_name = "Meshr API least-privilege runtime"
  depends_on   = [google_project_service.required]
}

resource "google_service_account" "api_canary" {
  account_id   = "meshr-api-canary"
  display_name = "Meshr canary API least-privilege runtime"
  depends_on   = [google_project_service.required]
}

# A one-shot bootstrap identity initializes the authority store and writes the
# topology generation attestation before API replicas are admitted. It is not
# used by a Deployment and is never granted to the public API service account.
resource "google_service_account" "bootstrap" {
  account_id   = "meshr-bootstrap"
  display_name = "Meshr one-shot production store bootstrap"
  depends_on   = [google_project_service.required]
}

resource "google_service_account" "bootstrap_canary" {
  account_id   = "meshr-bootstrap-canary"
  display_name = "Meshr one-shot canary store bootstrap"
  depends_on   = [google_project_service.required]
}

resource "google_service_account" "worker" {
  for_each     = local.worker_accounts
  account_id   = each.value.account_id
  display_name = "Meshr ${each.key} least-privilege runtime"
  depends_on   = [google_project_service.required]
}

resource "google_service_account" "canary_worker" {
  for_each     = local.canary_worker_accounts
  account_id   = each.value.account_id
  display_name = "Meshr canary ${each.key} least-privilege runtime"
  depends_on   = [google_project_service.required]
}

resource "google_service_account" "ingest" {
  account_id   = "meshr-ingest"
  display_name = "Meshr event ingest least-privilege runtime"
  depends_on   = [google_project_service.required]
}

resource "google_service_account" "ingest_canary" {
  account_id   = "meshr-ingest-canary"
  display_name = "Meshr canary event ingest least-privilege runtime"
  depends_on   = [google_project_service.required]
}

# The HPA's Pub/Sub backlog metric is served by the pinned GKE
# custom-metrics-stackdriver-adapter. Keep its Workload Identity separate from
# application workers: it needs Cloud Monitoring read access, but no
# Firestore, Pub/Sub publish, Secret Manager, or Cloud Run permissions.
resource "google_service_account" "metrics_adapter" {
  account_id   = "meshr-metrics-adapter"
  display_name = "Meshr GKE external metrics adapter"
  depends_on   = [google_project_service.required]
}

resource "google_project_iam_member" "metrics_adapter_monitoring_viewer" {
  project = var.project_id
  role    = "roles/monitoring.viewer"
  member  = "serviceAccount:${google_service_account.metrics_adapter.email}"
}

resource "google_service_account_iam_member" "metrics_adapter_workload_identity" {
  service_account_id = google_service_account.metrics_adapter.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[custom-metrics/custom-metrics-stackdriver-adapter]"
}

# Screening is isolated behind a small authenticated adapter. The event-plane
# workers receive only Cloud Run invocation permission; Model Armor and DLP
# permissions stay on this dedicated service identity. A launch apply must
# provide an immutable adapter image, while dry validation plans keep the
# service absent so no placeholder workload can accidentally reach production.
resource "google_service_account" "moderation_adapter" {
  account_id   = "meshr-moderation-adapter"
  display_name = "Meshr production moderation adapter"
  depends_on   = [google_project_service.required]
}

resource "google_service_account" "moderation_adapter_canary" {
  account_id   = "meshr-mod-adapter-canary"
  display_name = "Meshr canary moderation adapter"
  depends_on   = [google_project_service.required]
}

resource "google_cloud_run_v2_service" "moderation_adapter" {
  count               = var.moderation_adapter_image == null ? 0 : 1
  name                = "meshr-moderation-adapter"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = true

  template {
    service_account = google_service_account.moderation_adapter.email
    containers {
      image = var.moderation_adapter_image
      env {
        name  = "MESHR_ENV"
        value = "production"
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "MESHR_MODEL_ARMOR_TEMPLATE"
        value = coalesce(var.moderation_model_armor_template, "")
      }
      dynamic "env" {
        for_each = var.moderation_model_armor_endpoint == null ? [] : [var.moderation_model_armor_endpoint]
        content {
          name  = "MESHR_MODEL_ARMOR_ENDPOINT"
          value = env.value
        }
      }
      env {
        name  = "MESHR_DLP_LOCATION"
        value = var.moderation_dlp_location
      }
      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }
  }

  # The protected promotion workflow advances this service to the exact
  # signed digest after canary/release approval. Keep OpenTofu responsible for
  # the service, identity, and runtime configuration, but do not let a later
  # apply with bootstrap tfvars silently roll the adapter back to an older
  # image. The workflow records and verifies the deployed digest explicitly.
  lifecycle {
    ignore_changes = [template[0].containers[0].image]
  }

  depends_on = [google_project_service.required]
}

resource "google_cloud_run_v2_service" "moderation_adapter_canary" {
  count               = var.moderation_adapter_canary_image == null ? 0 : 1
  name                = "meshr-moderation-adapter-canary"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = true

  template {
    service_account = google_service_account.moderation_adapter_canary.email
    containers {
      image = var.moderation_adapter_canary_image
      env {
        name  = "MESHR_ENV"
        value = "production"
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "MESHR_MODEL_ARMOR_TEMPLATE"
        value = coalesce(var.moderation_model_armor_template, "")
      }
      dynamic "env" {
        for_each = var.moderation_model_armor_endpoint == null ? [] : [var.moderation_model_armor_endpoint]
        content {
          name  = "MESHR_MODEL_ARMOR_ENDPOINT"
          value = env.value
        }
      }
      env {
        name  = "MESHR_DLP_LOCATION"
        value = var.moderation_dlp_location
      }
      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }
  }

  # See the production adapter lifecycle rule above. Canary image revisions
  # are advanced only by the protected canary promotion job and must survive a
  # routine infrastructure refresh using the original bootstrap variables.
  lifecycle {
    ignore_changes = [template[0].containers[0].image]
  }

  depends_on = [google_project_service.required]
}

# GitHub Actions uses keyless Workload Identity Federation. The attribute
# condition is intentionally repository-scoped so a token from another
# repository cannot impersonate the release identity.
resource "google_iam_workload_identity_pool" "github_actions" {
  project                   = var.project_id
  workload_identity_pool_id = "meshr-github-actions"
  display_name              = "Meshr GitHub Actions"
  description               = "Keyless CI identity for verified Meshr releases."
  depends_on                = [google_project_service.required]
}

resource "google_iam_workload_identity_pool_provider" "github_actions" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github_actions.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
    "attribute.actor"      = "assertion.actor"
  }
  # Artifact builds are limited to the protected main workflow as well. A
  # branch-dispatched build must not be able to mint a signed image that the
  # production promotion job would later accept for a known main SHA.
  attribute_condition = "assertion.repository == '${var.github_repository}' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref == '${var.github_repository}/.github/workflows/ci.yml@refs/heads/main'"
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
  depends_on = [google_project_service.required]
}

# Production promotion uses a separate provider whose claim condition is tied
# to the protected environment, main ref, and this exact workflow file. The
# artifact-build provider above intentionally has no deploy permissions.
resource "google_iam_workload_identity_pool_provider" "github_actions_deploy" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github_actions.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-deploy"
  display_name                       = "GitHub OIDC production promotion"
  attribute_mapping = {
    "google.subject" = "assertion.sub"
    # Include the protected GitHub environment in the mapped attribute. IAM
    # principalSet bindings are pool-wide (not provider-scoped), so the
    # environment suffix prevents a canary token from impersonating the
    # production deploy identity.
    "attribute.release" = "assertion.repository + ':' + assertion.environment"
  }
  attribute_condition = "assertion.repository == '${var.github_repository}' && assertion.environment == 'production' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref == '${var.github_repository}/.github/workflows/ci.yml@refs/heads/main'"
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
  depends_on = [google_project_service.required]
}

resource "google_service_account" "ci" {
  account_id   = var.ci_service_account_id
  display_name = "Meshr GitHub Actions artifact-build identity"
  depends_on   = [google_project_service.required]
}

resource "google_service_account" "ci_deploy" {
  account_id   = var.ci_deploy_service_account_id
  display_name = "Meshr protected GitHub Actions production-deploy identity"
  depends_on   = [google_project_service.required]
}

resource "google_iam_workload_identity_pool_provider" "github_actions_canary_deploy" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github_actions.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-canary-deploy"
  display_name                       = "GitHub OIDC canary promotion"
  attribute_mapping = {
    "google.subject"    = "assertion.sub"
    "attribute.release" = "assertion.repository + ':' + assertion.environment"
  }
  attribute_condition = "assertion.repository == '${var.github_repository}' && assertion.environment == 'canary' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref == '${var.github_repository}/.github/workflows/ci.yml@refs/heads/main'"
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
  depends_on = [google_project_service.required]
}

resource "google_service_account" "ci_canary_deploy" {
  account_id   = var.ci_canary_deploy_service_account_id
  display_name = "Meshr protected GitHub Actions canary-deploy identity"
  depends_on   = [google_project_service.required]
}

resource "google_service_account_iam_member" "ci_workload_identity" {
  service_account_id = google_service_account.ci.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github_actions.name}/attribute.repository/${var.github_repository}"
}

resource "google_service_account_iam_member" "ci_deploy_workload_identity" {
  service_account_id = google_service_account.ci_deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github_actions.name}/attribute.release/${var.github_repository}:production"
}

resource "google_service_account_iam_member" "ci_canary_deploy_workload_identity" {
  service_account_id = google_service_account.ci_canary_deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github_actions.name}/attribute.release/${var.github_repository}:canary"
}

# Release jobs record cost-protection transitions in a dedicated Firestore
# database. Firestore IAM conditions are database-scoped (not collection-
# scoped), so isolating these receipts in their own database makes the
# database-wide datastore grant an honest least-privilege boundary.
resource "google_project_iam_member" "ci_deploy_audit_writer" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.ci_deploy.email}"
  condition {
    title       = "production-cost-audit-database-only"
    description = "Production release identity may write only the dedicated cost-protection audit database."
    expression  = "resource.name == 'projects/${var.project_id}/databases/${google_firestore_database.release_audit.name}'"
  }
}

resource "google_project_iam_member" "ci_canary_deploy_audit_writer" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.ci_canary_deploy.email}"
  condition {
    title       = "canary-cost-audit-database-only"
    description = "Canary release identity may write only the dedicated canary cost-protection audit database."
    expression  = "resource.name == 'projects/${var.project_id}/databases/${google_firestore_database.canary_release_audit.name}'"
  }
}

resource "google_project_iam_member" "ci_artifact_registry" {
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.ci.email}"
}

resource "google_project_iam_member" "ci_deploy_cluster_viewer" {
  project = var.project_id
  role    = "roles/container.clusterViewer"
  member  = "serviceAccount:${google_service_account.ci_deploy.email}"
}

resource "google_project_iam_member" "ci_deploy_artifact_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.ci_deploy.email}"
}

resource "google_project_iam_member" "ci_canary_deploy_cluster_viewer" {
  project = var.project_id
  role    = "roles/container.clusterViewer"
  member  = "serviceAccount:${google_service_account.ci_canary_deploy.email}"
}

resource "google_project_iam_member" "ci_canary_deploy_artifact_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.ci_canary_deploy.email}"
}

resource "google_project_iam_member" "ci_deploy_cloud_run_viewer" {
  project = var.project_id
  role    = "roles/run.viewer"
  member  = "serviceAccount:${google_service_account.ci_deploy.email}"
}

resource "google_project_iam_member" "ci_canary_deploy_cloud_run_viewer" {
  project = var.project_id
  role    = "roles/run.viewer"
  member  = "serviceAccount:${google_service_account.ci_canary_deploy.email}"
}

# Promotion jobs perform an authenticated adapter health preflight before
# mutating the canary or production release refs. Keep these invoker grants
# service-scoped and environment-specific; the deploy identities do not gain
# permission to invoke any other Cloud Run service.
resource "google_cloud_run_v2_service_iam_member" "ci_deploy_moderation_adapter_invoker" {
  count    = var.moderation_adapter_image == null ? 0 : 1
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.moderation_adapter[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.ci_deploy.email}"
}

resource "google_cloud_run_v2_service_iam_member" "ci_canary_deploy_moderation_adapter_invoker" {
  count    = var.moderation_adapter_canary_image == null ? 0 : 1
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.moderation_adapter_canary[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.ci_canary_deploy.email}"
}

# The protected promotion jobs move only the already signed moderation-adapter
# digest onto their matching Cloud Run service before they mint an ID token and
# run health checks. Keep the update permission service-scoped and pair it with
# actAs on the dedicated runtime identity; no other Cloud Run service can be
# changed by either release identity.
resource "google_cloud_run_v2_service_iam_member" "ci_deploy_moderation_adapter_developer" {
  count    = var.moderation_adapter_image == null ? 0 : 1
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.moderation_adapter[0].name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.ci_deploy.email}"
}

resource "google_cloud_run_v2_service_iam_member" "ci_canary_deploy_moderation_adapter_developer" {
  count    = var.moderation_adapter_canary_image == null ? 0 : 1
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.moderation_adapter_canary[0].name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.ci_canary_deploy.email}"
}

resource "google_service_account_iam_member" "ci_deploy_moderation_adapter_act_as" {
  count              = var.moderation_adapter_image == null ? 0 : 1
  service_account_id = google_service_account.moderation_adapter.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.ci_deploy.email}"
}

resource "google_service_account_iam_member" "ci_canary_deploy_moderation_adapter_act_as" {
  count              = var.moderation_adapter_canary_image == null ? 0 : 1
  service_account_id = google_service_account.moderation_adapter_canary.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.ci_canary_deploy.email}"
}

resource "google_project_iam_member" "gke_nodes_default_node_service_account" {
  project = var.project_id
  role    = "roles/container.defaultNodeServiceAccount"
  member  = "serviceAccount:${google_service_account.gke_nodes.email}"
}

resource "google_project_iam_member" "api_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.api.email}"
  condition {
    title       = "api-authority-database"
    description = "Production API may read and write only the authority Firestore database."
    expression  = local.authority_firestore_iam_expression
  }
}

resource "google_project_iam_member" "api_topology_firestore" {
  project = var.project_id
  role    = "roles/datastore.viewer"
  member  = "serviceAccount:${google_service_account.api.email}"
  condition {
    title       = "api-topology-database"
    description = "Production API may read aggregate activity projections in addition to its authority database."
    expression  = local.topology_firestore_iam_expression
  }
}

resource "google_project_iam_member" "bootstrap_authority_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.bootstrap.email}"
  condition {
    title       = "production-bootstrap-authority-database"
    description = "The one-shot production bootstrap may initialize only the configured authority Firestore database."
    expression  = local.authority_firestore_iam_expression
  }
}

resource "google_project_iam_member" "bootstrap_topology_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.bootstrap.email}"
  condition {
    title       = "production-bootstrap-topology-database"
    description = "The one-shot production bootstrap may attest and initialize only the configured topology Firestore database."
    expression  = local.topology_firestore_iam_expression
  }
}

resource "google_project_iam_member" "api_canary_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.api_canary.email}"
  condition {
    title       = "canary-firestore-database"
    description = "Canary API can access only the isolated canary Firestore database."
    expression  = "resource.name == 'projects/${var.project_id}/databases/meshr-canary'"
  }
}

resource "google_project_iam_member" "api_canary_topology_firestore" {
  project = var.project_id
  role    = "roles/datastore.viewer"
  member  = "serviceAccount:${google_service_account.api_canary.email}"
  condition {
    title       = "canary-api-topology-database"
    description = "Canary API may read aggregate activity projections in the isolated canary topology database."
    expression  = local.canary_topology_firestore_iam_expression
  }
}

resource "google_project_iam_member" "bootstrap_canary_authority_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.bootstrap_canary.email}"
  condition {
    title       = "canary-bootstrap-authority-database"
    description = "The one-shot canary bootstrap may initialize only the isolated canary authority Firestore database."
    expression  = "resource.name == 'projects/${var.project_id}/databases/meshr-canary'"
  }
}

resource "google_project_iam_member" "bootstrap_canary_topology_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.bootstrap_canary.email}"
  condition {
    title       = "canary-bootstrap-topology-database"
    description = "The one-shot canary bootstrap may attest and initialize only the isolated canary topology database."
    expression  = local.canary_topology_firestore_iam_expression
  }
}

resource "google_project_iam_member" "worker_firestore" {
  for_each = {
    for key, value in local.worker_accounts : key => value
    if key != "live_gateway" && key != "topology_materializer" &&
    key != "audit_worker" && key != "notification_worker" &&
    key != "moderation_worker" && key != "moderation_screening_worker"
  }
  project = var.project_id
  role    = each.value.firestore_role
  member  = "serviceAccount:${google_service_account.worker[each.key].email}"
  condition {
    title       = "${each.key}-authority-database"
    description = "Production ${each.key} worker can access only the authority Firestore database."
    expression  = local.authority_firestore_iam_expression
  }
}

resource "google_project_iam_member" "audit_worker_firestore" {
  project = var.project_id
  role    = local.worker_accounts.audit_worker.firestore_role
  member  = "serviceAccount:${google_service_account.worker["audit_worker"].email}"
  condition {
    title       = "audit-worker-database"
    description = "Production audit worker can access only delivery traces in the dedicated audit Firestore database."
    expression  = local.audit_firestore_iam_expression
  }
}

resource "google_project_iam_member" "notification_worker_firestore" {
  project = var.project_id
  role    = local.worker_accounts.notification_worker.firestore_role
  member  = "serviceAccount:${google_service_account.worker["notification_worker"].email}"
  condition {
    title       = "notification-worker-database"
    description = "Production notification worker can access only the dedicated notification Firestore database."
    expression  = local.notifications_firestore_iam_expression
  }
}

resource "google_project_iam_member" "moderation_worker_firestore" {
  project = var.project_id
  role    = local.worker_accounts.moderation_worker.firestore_role
  member  = "serviceAccount:${google_service_account.worker["moderation_worker"].email}"
  condition {
    title       = "moderation-worker-queue-database"
    description = "Production moderation intake can access only the dedicated moderation queue database."
    expression  = local.moderation_firestore_iam_expression
  }
}

resource "google_project_iam_member" "moderation_screening_worker_firestore" {
  project = var.project_id
  role    = local.worker_accounts.moderation_screening_worker.firestore_role
  member  = "serviceAccount:${google_service_account.worker["moderation_screening_worker"].email}"
  condition {
    title       = "moderation-screening-worker-queue-database"
    description = "Production moderation screening can access only the dedicated moderation queue database."
    expression  = local.moderation_firestore_iam_expression
  }
}

# Only the adapter workload may call Model Armor. The event-plane worker calls
# the adapter over its authenticated Cloud Run URL and has no provider-level
# permissions of its own.
resource "google_project_iam_member" "moderation_adapter_model_armor" {
  project = var.project_id
  role    = "roles/modelarmor.user"
  member  = "serviceAccount:${google_service_account.moderation_adapter.email}"
}

resource "google_project_iam_member" "moderation_adapter_dlp" {
  project = var.project_id
  role    = "roles/dlp.user"
  member  = "serviceAccount:${google_service_account.moderation_adapter.email}"
}

resource "google_cloud_run_v2_service_iam_member" "moderation_adapter_invoker" {
  count    = var.moderation_adapter_image == null ? 0 : 1
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.moderation_adapter[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.worker["moderation_screening_worker"].email}"
}

resource "google_project_iam_member" "live_gateway_topology_firestore" {
  project = var.project_id
  role    = "roles/datastore.viewer"
  member  = "serviceAccount:${google_service_account.worker["live_gateway"].email}"
  condition {
    title       = "live-gateway-topology-database"
    description = "The public live gateway may read only aggregate topology projections."
    expression  = local.topology_firestore_iam_expression
  }
}

resource "google_project_iam_member" "topology_materializer_projection_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.worker["topology_materializer"].email}"
  condition {
    title       = "topology-materializer-projection-database"
    description = "The topology materializer writes only the aggregate projection database in this grant."
    expression  = local.topology_firestore_iam_expression
  }
}

resource "google_project_iam_member" "canary_worker_firestore" {
  for_each = {
    for key, value in local.canary_worker_accounts : key => value
    if key != "live_gateway" && key != "topology_materializer" &&
    key != "audit_worker" && key != "notification_worker" &&
    key != "moderation_worker" && key != "moderation_screening_worker"
  }
  project = var.project_id
  role    = each.value.firestore_role
  member  = "serviceAccount:${google_service_account.canary_worker[each.key].email}"
  condition {
    title       = "canary-firestore-database-${each.key}"
    description = "Canary event worker can access only the isolated canary Firestore database."
    expression  = "resource.name == 'projects/${var.project_id}/databases/meshr-canary'"
  }
}

resource "google_project_iam_member" "canary_audit_worker_firestore" {
  project = var.project_id
  role    = local.canary_worker_accounts.audit_worker.firestore_role
  member  = "serviceAccount:${google_service_account.canary_worker["audit_worker"].email}"
  condition {
    title       = "canary-audit-worker-database"
    description = "Canary audit worker can access only delivery traces in the dedicated canary audit Firestore database."
    expression  = local.canary_audit_firestore_iam_expression
  }
}

resource "google_project_iam_member" "canary_notification_worker_firestore" {
  project = var.project_id
  role    = local.canary_worker_accounts.notification_worker.firestore_role
  member  = "serviceAccount:${google_service_account.canary_worker["notification_worker"].email}"
  condition {
    title       = "canary-notification-worker-database"
    description = "Canary notification worker can access only the dedicated canary notification Firestore database."
    expression  = local.canary_notifications_firestore_iam_expression
  }
}

resource "google_project_iam_member" "canary_moderation_worker_firestore" {
  project = var.project_id
  role    = local.canary_worker_accounts.moderation_worker.firestore_role
  member  = "serviceAccount:${google_service_account.canary_worker["moderation_worker"].email}"
  condition {
    title       = "canary-moderation-worker-queue-database"
    description = "Canary moderation intake can access only the dedicated canary moderation queue database."
    expression  = local.canary_moderation_firestore_iam_expression
  }
}

resource "google_project_iam_member" "canary_moderation_screening_worker_firestore" {
  project = var.project_id
  role    = local.canary_worker_accounts.moderation_screening_worker.firestore_role
  member  = "serviceAccount:${google_service_account.canary_worker["moderation_screening_worker"].email}"
  condition {
    title       = "canary-moderation-screening-worker-queue-database"
    description = "Canary moderation screening can access only the dedicated canary moderation queue database."
    expression  = local.canary_moderation_firestore_iam_expression
  }
}

resource "google_project_iam_member" "canary_moderation_adapter_model_armor" {
  project = var.project_id
  role    = "roles/modelarmor.user"
  member  = "serviceAccount:${google_service_account.moderation_adapter_canary.email}"
}

resource "google_project_iam_member" "canary_moderation_adapter_dlp" {
  project = var.project_id
  role    = "roles/dlp.user"
  member  = "serviceAccount:${google_service_account.moderation_adapter_canary.email}"
}

resource "google_cloud_run_v2_service_iam_member" "canary_moderation_adapter_invoker" {
  count    = var.moderation_adapter_canary_image == null ? 0 : 1
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.moderation_adapter_canary[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.canary_worker["moderation_screening_worker"].email}"
}

resource "google_project_iam_member" "canary_live_gateway_topology_firestore" {
  project = var.project_id
  role    = "roles/datastore.viewer"
  member  = "serviceAccount:${google_service_account.canary_worker["live_gateway"].email}"
  condition {
    title       = "canary-live-gateway-topology-database"
    description = "The canary live gateway may read only aggregate canary topology projections."
    expression  = local.canary_topology_firestore_iam_expression
  }
}

resource "google_project_iam_member" "canary_topology_materializer_projection_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.canary_worker["topology_materializer"].email}"
  condition {
    title       = "canary-topology-materializer-projection-database"
    description = "The canary topology materializer writes only the aggregate projection database in this grant."
    expression  = local.canary_topology_firestore_iam_expression
  }
}

resource "google_pubsub_subscription_iam_member" "worker_subscriber" {
  for_each     = local.worker_subscriptions
  project      = var.project_id
  subscription = google_pubsub_subscription.workers[each.value].name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.worker[each.key].email}"
}

resource "google_pubsub_subscription_iam_member" "canary_worker_subscriber" {
  for_each     = local.canary_worker_subscriptions
  project      = var.project_id
  subscription = google_pubsub_subscription.canary_workers[each.value].name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.canary_worker[each.key].email}"
}

resource "google_pubsub_subscription_iam_member" "moderation_screening_worker_subscriber" {
  project      = var.project_id
  subscription = google_pubsub_subscription.moderation_screening.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.worker["moderation_screening_worker"].email}"
}

resource "google_pubsub_subscription_iam_member" "canary_moderation_screening_worker_subscriber" {
  project      = var.project_id
  subscription = google_pubsub_subscription.moderation_screening_canary.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.canary_worker["moderation_screening_worker"].email}"
}

resource "google_project_iam_member" "ingest_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.ingest.email}"
  condition {
    title       = "ingest-authority-database"
    description = "Production ingest can access only the authority Firestore database."
    expression  = local.authority_firestore_iam_expression
  }
}

resource "google_project_iam_member" "ingest_canary_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.ingest_canary.email}"
  condition {
    title       = "canary-ingest-firestore-database"
    description = "Canary ingest can access only the isolated canary Firestore database."
    expression  = "resource.name == 'projects/${var.project_id}/databases/meshr-canary'"
  }
}

resource "google_pubsub_topic_iam_member" "ingest_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.events.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.ingest.email}"
}

resource "google_pubsub_topic_iam_member" "ingest_canary_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.events_canary.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.ingest_canary.email}"
}

# The ingest readiness probe verifies that the configured events topic exists.
# `roles/pubsub.publisher` intentionally does not include pubsub.topics.get,
# so grant only topic metadata visibility rather than broad project viewer.
resource "google_pubsub_topic_iam_member" "ingest_topic_viewer" {
  project = var.project_id
  topic   = google_pubsub_topic.events.name
  role    = "roles/pubsub.viewer"
  member  = "serviceAccount:${google_service_account.ingest.email}"
}

resource "google_pubsub_topic_iam_member" "ingest_canary_topic_viewer" {
  project = var.project_id
  topic   = google_pubsub_topic.events_canary.name
  role    = "roles/pubsub.viewer"
  member  = "serviceAccount:${google_service_account.ingest_canary.email}"
}

resource "google_pubsub_topic_iam_member" "moderation_screening_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.moderation_screening.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.worker["moderation_worker"].email}"
}

resource "google_pubsub_topic_iam_member" "canary_moderation_screening_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.moderation_screening_canary.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.canary_worker["moderation_worker"].email}"
}

# GKE Workload Identity links the namespaced service accounts in the
# production overlay to their least-privilege Google service accounts.
resource "google_service_account_iam_member" "api_workload_identity" {
  service_account_id = google_service_account.api.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[meshr/meshr-api]"
}

resource "google_service_account_iam_member" "api_canary_workload_identity" {
  service_account_id = google_service_account.api_canary.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[meshr-canary/meshr-api-canary]"
}

resource "google_service_account_iam_member" "bootstrap_workload_identity" {
  service_account_id = google_service_account.bootstrap.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[meshr/meshr-bootstrap]"
}

resource "google_service_account_iam_member" "bootstrap_canary_workload_identity" {
  service_account_id = google_service_account.bootstrap_canary.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[meshr-canary/meshr-bootstrap-canary]"
}

resource "google_service_account_iam_member" "canary_worker_workload_identity" {
  for_each           = local.canary_worker_accounts
  service_account_id = google_service_account.canary_worker[each.key].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[meshr-canary/${each.value.kubernetes_name}]"
}

resource "google_service_account_iam_member" "ingest_canary_workload_identity" {
  service_account_id = google_service_account.ingest_canary.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[meshr-canary/meshr-ingest-canary]"
}

resource "google_service_account_iam_member" "worker_workload_identity" {
  for_each           = local.worker_accounts
  service_account_id = google_service_account.worker[each.key].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[meshr/${each.value.kubernetes_name}]"
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
    "${var.project_id}.firebaseapp.com",
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
    api_targets {
      service = "securetoken.googleapis.com"
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
  name       = "meshr-social-root"
  domain     = var.zone_name
  depends_on = [google_project_service.required]
}

resource "google_certificate_manager_dns_authorization" "staging" {
  project    = var.project_id
  location   = "global"
  name       = "meshr-social-staging"
  domain     = "staging.${var.zone_name}"
  depends_on = [google_project_service.required]
}

# Certificate Manager publishes a DNS-01 record that must be visible through
# Cloudflare before the managed certificate can be issued. Keep this record
# DNS-only; proxying validation records prevents Certificate Manager from
# observing the challenge.
resource "cloudflare_record" "certificate_authorization" {
  count   = local.cloudflare_enabled ? 1 : 0
  zone_id = data.cloudflare_zone.meshr[0].id
  name    = google_certificate_manager_dns_authorization.meshr.dns_resource_record[0].name
  type    = google_certificate_manager_dns_authorization.meshr.dns_resource_record[0].type
  value   = google_certificate_manager_dns_authorization.meshr.dns_resource_record[0].data
  # Keep validation records DNS-only; automatic TTL avoids stale challenges.
  ttl     = 1
  proxied = false
}

resource "cloudflare_record" "staging_certificate_authorization" {
  count   = local.cloudflare_enabled ? 1 : 0
  zone_id = data.cloudflare_zone.meshr[0].id
  name    = google_certificate_manager_dns_authorization.staging.dns_resource_record[0].name
  type    = google_certificate_manager_dns_authorization.staging.dns_resource_record[0].type
  value   = google_certificate_manager_dns_authorization.staging.dns_resource_record[0].data
  # Keep validation records DNS-only; automatic TTL avoids stale challenges.
  ttl     = 1
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
    dns_authorizations = [
      google_certificate_manager_dns_authorization.meshr.id,
      google_certificate_manager_dns_authorization.staging.id,
    ]
  }
  depends_on = [
    cloudflare_record.certificate_authorization,
    cloudflare_record.staging_certificate_authorization,
  ]
}

resource "google_certificate_manager_certificate_map" "meshr" {
  project    = var.project_id
  name       = "meshr-social"
  depends_on = [google_project_service.required]
}

resource "google_certificate_manager_certificate_map_entry" "root" {
  project      = var.project_id
  name         = "meshr-social-root"
  map          = google_certificate_manager_certificate_map.meshr.name
  hostname     = var.zone_name
  certificates = [google_certificate_manager_certificate.meshr.id]
  depends_on   = [google_project_service.required]
}

resource "google_certificate_manager_certificate_map_entry" "staging" {
  project      = var.project_id
  name         = "meshr-social-staging"
  map          = google_certificate_manager_certificate_map.meshr.name
  hostname     = "staging.${var.zone_name}"
  certificates = [google_certificate_manager_certificate.meshr.id]
  depends_on   = [google_project_service.required]
}

# Reserve the Gateway address before the first deployment. DNS can therefore
# point at a stable target while the managed GKE Gateway is reconciled and
# during later Gateway rollouts.
resource "google_compute_global_address" "gateway" {
  project      = var.project_id
  name         = "meshr-gateway"
  address_type = "EXTERNAL"
  ip_version   = "IPV4"
  depends_on   = [google_project_service.required]
}

# Keep the canary edge on its own static address. GKE Gateway does not support
# two independent Gateways sharing one named address, and the staging route
# must remain reachable while the production Gateway is absent or rolling out.
resource "google_compute_global_address" "staging_gateway" {
  project      = var.project_id
  name         = "meshr-staging-gateway"
  address_type = "EXTERNAL"
  ip_version   = "IPV4"
  depends_on   = [google_project_service.required]
}

resource "google_secret_manager_secret" "internal_token" {
  secret_id = "meshr-internal-token"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret" "moderation_authority_token" {
  secret_id = "meshr-moderation-authority-token"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret" "identity_api_key" {
  secret_id = "meshr-identity-api-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret" "renewal_recovery" {
  secret_id = "meshr-renewal-recovery"
  replication {
    auto {}
  }
  # This key is consumed only by the API for deterministic lost-response
  # recovery. It must never be readable by the live gateway or event workers.
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret" "renewal_recovery_previous" {
  secret_id = "meshr-renewal-recovery-previous"
  replication {
    auto {}
  }
  # Keep exactly one previous recovery key available during rotation so a
  # retry can recover a successor committed by an older API replica.
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret" "invitation_pepper" {
  secret_id = "meshr-invitation-pepper"
  replication {
    auto {}
  }
  # HMAC pepper for role-invitation addressing. Populate a version through
  # Secret Manager before the first API rollout; Terraform never stores the
  # plaintext value in state.
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret" "invitation_pepper_previous" {
  secret_id = "meshr-invitation-pepper-previous"
  replication {
    auto {}
  }
  # Outstanding role invitations can live for thirty days; retain the
  # previous HMAC pepper for that overlap window during rotation.
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret" "canary_internal_token" {
  secret_id = "meshr-canary-internal-token"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret" "canary_moderation_authority_token" {
  secret_id = "meshr-canary-moderation-authority-token"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret" "canary_identity_api_key" {
  secret_id = "meshr-canary-identity-api-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret" "canary_renewal_recovery" {
  secret_id = "meshr-canary-renewal-recovery"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret" "canary_renewal_recovery_previous" {
  secret_id = "meshr-canary-renewal-recovery-previous"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret" "canary_invitation_pepper" {
  secret_id = "meshr-canary-invitation-pepper"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret" "canary_invitation_pepper_previous" {
  secret_id = "meshr-canary-invitation-pepper-previous"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_iam_member" "api_identity_api_key" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.identity_api_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "api_moderation_authority_token" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.moderation_authority_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "moderation_screening_authority_token" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.moderation_authority_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.worker["moderation_screening_worker"].email}"
}

resource "google_secret_manager_secret_iam_member" "api_renewal_recovery" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.renewal_recovery.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "api_renewal_recovery_previous" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.renewal_recovery_previous.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "api_invitation_pepper" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.invitation_pepper.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "api_invitation_pepper_previous" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.invitation_pepper_previous.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "api_canary_identity_api_key" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.canary_identity_api_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api_canary.email}"
}

resource "google_secret_manager_secret_iam_member" "api_canary_moderation_authority_token" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.canary_moderation_authority_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api_canary.email}"
}

resource "google_secret_manager_secret_iam_member" "canary_moderation_screening_authority_token" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.canary_moderation_authority_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.canary_worker["moderation_screening_worker"].email}"
}

resource "google_secret_manager_secret_iam_member" "api_canary_renewal_recovery" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.canary_renewal_recovery.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api_canary.email}"
}

resource "google_secret_manager_secret_iam_member" "api_canary_renewal_recovery_previous" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.canary_renewal_recovery_previous.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api_canary.email}"
}

resource "google_secret_manager_secret_iam_member" "api_canary_invitation_pepper" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.canary_invitation_pepper.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api_canary.email}"
}

resource "google_secret_manager_secret_iam_member" "api_canary_invitation_pepper_previous" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.canary_invitation_pepper_previous.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api_canary.email}"
}

resource "google_secret_manager_secret_iam_member" "ingest_internal_token" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.internal_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.ingest.email}"
}

resource "google_secret_manager_secret_iam_member" "ingest_canary_internal_token" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.canary_internal_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.ingest_canary.email}"
}

data "cloudflare_zone" "meshr" {
  count = local.cloudflare_enabled ? 1 : 0
  name  = local.edge_host_root
}

# Cloudflare is the only public edge. Set a zone-specific header after the
# client request reaches Cloudflare and overwrite any user-supplied value;
# Cloud Armor validates it before the request reaches GKE. The value is a
# sensitive protected input, and the remote OpenTofu state bucket must be
# access-controlled because the Cloudflare API stores the transform action.
resource "cloudflare_ruleset" "meshr_origin_auth" {
  count       = local.cloudflare_enabled ? 1 : 0
  zone_id     = data.cloudflare_zone.meshr[0].id
  name        = "meshr-origin-auth"
  description = "Authenticate Meshr proxied requests at the GCP origin."
  kind        = "zone"
  # Request-header rewrites run in Cloudflare's late-transform phase.
  phase = "http_request_late_transform"

  rules {
    ref         = "meshr_origin_auth_header"
    description = "Overwrite the origin-auth header for Meshr listeners."
    expression  = "(http.host eq \"${local.edge_host_root}\" or http.host eq \"${local.edge_host_staging}\")"
    action      = "rewrite"

    action_parameters {
      headers {
        name      = "x-meshr-origin-secret"
        operation = "set"
        value     = local.edge_origin_secret
      }
    }
  }
}

resource "cloudflare_zone_settings_override" "tls" {
  count   = (var.manage_production_dns_records || var.manage_staging_dns_records) ? 1 : 0
  zone_id = data.cloudflare_zone.meshr[0].id
  settings {
    ssl              = "strict"
    always_use_https = "on"
    min_tls_version  = "1.2"
  }
}

resource "cloudflare_record" "root" {
  count   = var.manage_production_dns_records ? 1 : 0
  zone_id = data.cloudflare_zone.meshr[0].id
  name    = "@"
  type    = "A"
  value   = google_compute_global_address.gateway.address
  # Cloudflare requires proxied records to use automatic TTL (1).
  ttl     = 1
  proxied = true
  comment = "Meshr public Gateway static address; verify Full (strict) TLS before enabling traffic."
}

resource "cloudflare_record" "staging" {
  count   = var.manage_staging_dns_records ? 1 : 0
  zone_id = data.cloudflare_zone.meshr[0].id
  name    = "staging"
  type    = "A"
  value   = google_compute_global_address.staging_gateway.address
  # Cloudflare requires proxied records to use automatic TTL (1).
  ttl     = 1
  proxied = true
  comment = "Meshr canary hostname on the independent staging Gateway static address."
}

resource "google_monitoring_alert_policy" "pubsub_backlog" {
  display_name          = "Meshr Pub/Sub backlog"
  combiner              = "OR"
  notification_channels = local.monitoring_notification_channels
  depends_on            = [google_project_service.required]
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

# Structured application logs are the portable telemetry boundary for the
# first public release. These log-based metrics keep the launch budget small
# while giving Cloud Monitoring durable request/error/authorization signals;
# OpenTelemetry can be layered on without changing the HTTP contract.
resource "google_logging_metric" "http_request_count" {
  name   = "meshr_http_request_count"
  filter = "jsonPayload.component=\"meshr-api\" AND jsonPayload.event=\"http.request\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key         = "status_class"
      value_type  = "STRING"
      description = "First digit of the HTTP status code (2, 4, or 5)."
    }
  }
  label_extractors = {
    status_class = "REGEXP_EXTRACT(jsonPayload.status, \"^([0-9])\")"
  }
}

resource "google_logging_metric" "http_request_latency" {
  name   = "meshr_http_request_latency_ms"
  filter = "jsonPayload.component=\"meshr-api\" AND jsonPayload.event=\"http.request\" AND jsonPayload.latency_ms:*"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"
  }
  value_extractor = "EXTRACT(jsonPayload.latency_ms)"
  bucket_options {
    explicit_buckets {
      bounds = [50, 100, 250, 500, 750, 1000, 2000, 5000, 10000]
    }
  }
}

resource "google_logging_metric" "http_write_request_latency" {
  name   = "meshr_http_write_request_latency_ms"
  filter = "jsonPayload.component=\"meshr-api\" AND jsonPayload.event=\"http.request\" AND jsonPayload.is_write=true AND jsonPayload.latency_ms:*"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"
  }
  value_extractor = "EXTRACT(jsonPayload.latency_ms)"
  bucket_options {
    explicit_buckets {
      bounds = [50, 100, 250, 500, 750, 1000, 2000, 5000, 10000]
    }
  }
}

resource "google_logging_metric" "http_error_count" {
  name   = "meshr_http_error_count"
  filter = "jsonPayload.component=\"meshr-api\" AND jsonPayload.event=\"http.request\" AND jsonPayload.status>=400"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "auth_failure_count" {
  name   = "meshr_auth_failure_count"
  filter = "jsonPayload.component=\"meshr-api\" AND jsonPayload.event=\"http.request\" AND jsonPayload.status=401"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "topology_propagation_lag" {
  name   = "meshr_topology_propagation_lag_ms"
  filter = "jsonPayload.component=\"meshr-topology-materializer\" AND jsonPayload.event=\"topology.snapshot.flushed\" AND jsonPayload.propagation_lag_ms:*"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"
  }
  value_extractor = "EXTRACT(jsonPayload.propagation_lag_ms)"
  bucket_options {
    explicit_buckets {
      bounds = [250, 500, 1000, 2000, 5000, 10000, 30000]
    }
  }
}

resource "google_logging_metric" "live_disconnect_count" {
  name   = "meshr_live_disconnect_count"
  filter = "jsonPayload.component=\"meshr-live-gateway\" AND jsonPayload.event=\"live.connection\" AND jsonPayload.action=\"closed\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "outbox_failure_count" {
  name   = "meshr_outbox_failure_count"
  filter = "jsonPayload.component=\"meshr-ingest\" AND (jsonPayload.event=\"outbox_batch_publish_failed\" OR jsonPayload.event=\"outbox_async_publish_failed\")"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "store_unavailable_count" {
  name   = "meshr_store_unavailable_count"
  filter = "jsonPayload.component=\"meshr-api\" AND jsonPayload.event=\"http.request\" AND (jsonPayload.error_code=\"authorization_store_unavailable\" OR jsonPayload.error_code=\"projection_unavailable\" OR jsonPayload.error_code=\"activity_store_unavailable\")"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "moderation_failure_count" {
  name   = "meshr_moderation_failure_count"
  filter = "jsonPayload.component=\"meshr-moderation-adapter\" AND jsonPayload.event=\"moderation.adapter_request\" AND jsonPayload.status>=500"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "moderation_request_latency" {
  name   = "meshr_moderation_request_latency_ms"
  filter = "jsonPayload.component=\"meshr-moderation-adapter\" AND jsonPayload.event=\"moderation.adapter_request\" AND jsonPayload.latency_ms:*"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"
  }
  value_extractor = "EXTRACT(jsonPayload.latency_ms)"
  bucket_options {
    explicit_buckets {
      bounds = [50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000]
    }
  }
}

resource "google_logging_metric" "moderation_dlq_count" {
  name   = "meshr_moderation_dlq_count"
  filter = "jsonPayload.component=\"meshr-materializer\" AND jsonPayload.event=\"moderation.dlq\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "worker_firestore_error_count" {
  name   = "meshr_worker_firestore_error_count"
  filter = "jsonPayload.component=\"meshr-materializer\" AND jsonPayload.event=\"materialization.failed\" AND jsonPayload.error_class=\"firestore\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "live_active_connections" {
  name   = "meshr_live_active_connections"
  filter = "jsonPayload.component=\"meshr-live-gateway\" AND jsonPayload.event=\"live.connection.gauge\" AND jsonPayload.active_connections:*"
  metric_descriptor {
    # Extracted log values are represented as a distribution. A sampled
    # connection count is then aligned as a percentile for capacity alerts;
    # using GAUGE/INT64 with value_extractor is rejected by Cloud Logging.
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "1"
  }
  value_extractor = "EXTRACT(jsonPayload.active_connections)"
  bucket_options {
    explicit_buckets {
      bounds = [0, 50, 100, 200, 300, 400, 450, 500, 750, 1000]
    }
  }
}

resource "google_logging_metric" "live_snapshot_ready_latency" {
  name   = "meshr_live_snapshot_ready_latency_ms"
  filter = "jsonPayload.component=\"meshr-live-gateway\" AND jsonPayload.event=\"live.connection_ready\" AND jsonPayload.snapshot_ready_ms:*"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"
  }
  value_extractor = "EXTRACT(jsonPayload.snapshot_ready_ms)"
  bucket_options {
    explicit_buckets {
      bounds = [100, 250, 500, 1000, 2000, 5000, 10000, 30000]
    }
  }
}

# Every launch alert must have an explicit human destination. Keeping the
# channel optional for dry validation plans makes CI useful without provider
# credentials, while launch_mode=true requires the routed channel through the
# guard above.
resource "google_monitoring_notification_channel" "operations_email" {
  count        = var.alert_notification_email == null ? 0 : 1
  display_name = "Meshr operations email"
  type         = "email"
  labels = {
    email_address = trimspace(var.alert_notification_email)
  }
}

resource "google_monitoring_alert_policy" "http_latency" {
  display_name          = "Meshr API write p95 latency"
  combiner              = "OR"
  notification_channels = local.monitoring_notification_channels
  depends_on            = [google_project_service.required]
  conditions {
    display_name = "write latency above launch target"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/meshr_http_write_request_latency_ms\" resource.type=\"k8s_container\""
      comparison      = "COMPARISON_GT"
      threshold_value = 750
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_PERCENTILE_95"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "http_errors" {
  display_name          = "Meshr API HTTP errors"
  combiner              = "OR"
  notification_channels = local.monitoring_notification_channels
  depends_on            = [google_project_service.required]
  conditions {
    display_name = "server and authorization errors"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/meshr_http_error_count\" resource.type=\"k8s_container\""
      comparison      = "COMPARISON_GT"
      threshold_value = 10
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "auth_failures" {
  display_name          = "Meshr authentication failures"
  combiner              = "OR"
  notification_channels = local.monitoring_notification_channels
  depends_on            = [google_project_service.required]
  conditions {
    display_name = "authentication failures above baseline"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/meshr_auth_failure_count\" resource.type=\"k8s_container\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "topology_lag" {
  display_name          = "Meshr topology propagation lag"
  combiner              = "OR"
  notification_channels = local.monitoring_notification_channels
  depends_on            = [google_project_service.required]
  conditions {
    display_name = "topology p95 lag above two seconds"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/meshr_topology_propagation_lag_ms\" resource.type=\"k8s_container\""
      comparison      = "COMPARISON_GT"
      threshold_value = 2000
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_PERCENTILE_95"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "live_disconnects" {
  display_name          = "Meshr live gateway disconnects"
  combiner              = "OR"
  notification_channels = local.monitoring_notification_channels
  depends_on            = [google_project_service.required]
  conditions {
    display_name = "gateway disconnects above baseline"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/meshr_live_disconnect_count\" resource.type=\"k8s_container\""
      comparison      = "COMPARISON_GT"
      threshold_value = 50
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "outbox_failures" {
  display_name          = "Meshr outbox delivery failures"
  combiner              = "OR"
  notification_channels = local.monitoring_notification_channels
  depends_on            = [google_project_service.required]
  conditions {
    display_name = "outbox failures present"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/meshr_outbox_failure_count\" resource.type=\"k8s_container\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "store_unavailable" {
  display_name          = "Meshr durable store unavailable"
  combiner              = "OR"
  notification_channels = local.monitoring_notification_channels
  depends_on            = [google_project_service.required]
  conditions {
    display_name = "authority or projection store errors"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/meshr_store_unavailable_count\" resource.type=\"k8s_container\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "moderation_failures" {
  display_name          = "Meshr moderation adapter failures"
  combiner              = "OR"
  notification_channels = local.monitoring_notification_channels
  depends_on            = [google_project_service.required]
  conditions {
    display_name = "moderation provider errors"
    condition_threshold {
      # The moderation adapter is a separately deployed Cloud Run service;
      # using its monitored-resource type keeps this alert tied to provider
      # failures instead of the Kubernetes screening worker.
      filter          = "metric.type=\"logging.googleapis.com/user/meshr_moderation_failure_count\" resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "moderation_latency" {
  display_name          = "Meshr moderation provider p95 latency"
  combiner              = "OR"
  notification_channels = local.monitoring_notification_channels
  depends_on            = [google_project_service.required]
  conditions {
    display_name = "moderation p95 above two seconds"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/meshr_moderation_request_latency_ms\" resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 2000
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_PERCENTILE_95"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "moderation_dlq" {
  display_name          = "Meshr moderation dead-letter volume"
  combiner              = "OR"
  notification_channels = local.monitoring_notification_channels
  depends_on            = [google_project_service.required]
  conditions {
    display_name = "moderation items dead-lettered"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/meshr_moderation_dlq_count\" resource.type=\"k8s_container\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      # A DLQ item is an incident even when it is isolated. One aligned
      # sample is enough to page; requiring a sustained window would miss
      # sparse dead letters entirely.
      duration = "0s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "worker_firestore_errors" {
  display_name          = "Meshr worker Firestore errors"
  combiner              = "OR"
  notification_channels = local.monitoring_notification_channels
  depends_on            = [google_project_service.required]
  conditions {
    display_name = "worker Firestore failures present"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/meshr_worker_firestore_error_count\" resource.type=\"k8s_container\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "live_active_connections" {
  display_name          = "Meshr live gateway connection capacity"
  combiner              = "OR"
  notification_channels = local.monitoring_notification_channels
  depends_on            = [google_project_service.required]
  conditions {
    display_name = "active WebSocket connections near per-pod ceiling"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/meshr_live_active_connections\" resource.type=\"k8s_container\""
      comparison      = "COMPARISON_GT"
      threshold_value = 450
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_PERCENTILE_95"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "live_snapshot_ready" {
  display_name          = "Meshr live snapshot readiness"
  combiner              = "OR"
  notification_channels = local.monitoring_notification_channels
  depends_on            = [google_project_service.required]
  conditions {
    display_name = "snapshot readiness p95 above five seconds"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/meshr_live_snapshot_ready_latency_ms\" resource.type=\"k8s_container\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5000
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_PERCENTILE_95"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "pubsub_dead_letters" {
  display_name          = "Meshr Pub/Sub dead-letter volume"
  combiner              = "OR"
  notification_channels = local.monitoring_notification_channels
  depends_on            = [google_project_service.required]
  conditions {
    display_name = "messages routed to a dead-letter topic"
    condition_threshold {
      filter          = "resource.type=\"pubsub_subscription\" metric.type=\"pubsub.googleapis.com/subscription/dead_letter_message_count\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
}

resource "google_billing_budget" "launch" {
  count           = try(trimspace(var.billing_account_id), "") == "" ? 0 : 1
  depends_on      = [google_project_service.required]
  billing_account = var.billing_account_id
  display_name    = "Meshr launch budget"
  budget_filter {
    # A billing account can host unrelated projects. Scope the 50/75/90/95%
    # alerts to Meshr so application protection is not triggered by another
    # tenant's spend.
    projects = ["projects/${data.google_project.current.number}"]
  }
  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.monthly_budget_usd)
    }
  }
  all_updates_rule {
    monitoring_notification_channels = local.monitoring_notification_channels
  }
  threshold_rules {
    threshold_percent = 0.5
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 0.75
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 0.9
    spend_basis       = "CURRENT_SPEND"
  }
  # The 95% signal is the operator trigger for switching the protected
  # runtime-values mode to `protect`/`throttle`; GCP budgets remain alerts and
  # cannot enforce a hard spending cap by themselves.
  threshold_rules {
    threshold_percent = 0.95
    spend_basis       = "FORECASTED_SPEND"
  }
}
