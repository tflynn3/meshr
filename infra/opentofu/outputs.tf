output "cluster_name" {
  value = google_container_cluster.autopilot.name
}

output "fleet_membership" {
  value       = google_container_cluster.autopilot.fleet[0].membership
  description = "Full regional fleet membership used by the production Connect Gateway path."
}

output "fleet_membership_id" {
  value       = google_container_cluster.autopilot.fleet[0].membership_id
  description = "Short membership name passed to gcloud container fleet memberships get-credentials."
}

output "fleet_membership_location" {
  value       = google_container_cluster.autopilot.fleet[0].membership_location
  description = "Regional fleet membership location passed explicitly to Connect Gateway commands."
}

output "connect_gateway_deploy_service_account" {
  value       = var.connect_gateway_deploy_service_account_email
  description = "Exact protected deploy identity granted Connect Gateway transport access; Kubernetes RBAC remains independently namespace-scoped."
}

output "region" {
  value = var.region
}

output "organization_policy_guardrails_enforced" {
  value       = var.organization_policy_guardrails_enabled
  description = "Whether this apply manages the five project-level Organization Policy guardrails. This must be true before public launch or either DNS-management path is enabled."
}

output "gke_network" {
  value       = google_compute_network.gke.name
  description = "Dedicated custom-mode VPC used only by the Meshr GKE cluster."
}

output "gke_subnetwork" {
  value       = google_compute_subnetwork.gke.name
  description = "Regional private-node subnet with explicit Pod and Service secondary ranges."
}

output "gke_nat_ip" {
  value       = google_compute_address.gke_nat.address
  description = "Stable Cloud NAT egress address for private Meshr GKE workloads and outbound allowlists."
}

output "gateway_ip" {
  value       = try(google_compute_global_address.gateway[0].address, null)
  description = "Reserved global IPv4 address used by the production GKE Gateway and root Cloudflare record; null while edge management is disabled."
}

output "staging_gateway_ip" {
  value       = try(google_compute_global_address.staging_gateway[0].address, null)
  description = "Reserved global IPv4 address used by the independent canary Gateway and staging Cloudflare record; null while edge management is disabled."
}

output "artifact_registry" {
  value = google_artifact_registry_repository.images.name
}

output "gke_node_service_account" {
  value       = google_service_account.gke_nodes.email
  description = "Dedicated node identity used by GKE Autopilot to pull private Meshr images."
}

output "api_service_account" {
  value = google_service_account.api.email
}

output "ingest_service_account" {
  value = google_service_account.ingest.email
}

output "metrics_adapter_service_account" {
  value       = google_service_account.metrics_adapter.email
  description = "Dedicated GKE external-metrics adapter identity with Cloud Monitoring read access only."
}

output "moderation_adapter_service_account" {
  value       = google_service_account.moderation_adapter.email
  description = "Exact production adapter runtime identity holding Model Armor and Sensitive Data Protection permissions; private promotion may act as only this service account."
}

output "moderation_adapter_service_name" {
  value       = try(google_cloud_run_v2_service.moderation_adapter[0].name, null)
  description = "Exact production Cloud Run service name on which the private promotion identity receives service-scoped revision authority."
}

output "moderation_adapter_initial_revision" {
  value       = var.moderation_adapter_image == null ? null : local.moderation_adapter_revision_name
  description = "Deterministic create-only production revision name derived from the first 20 characters of moderation_adapter_source_sha."
}

output "moderation_adapter_initial_revision_tag" {
  value       = var.moderation_adapter_image == null ? null : local.moderation_adapter_revision_tag
  description = "Deterministic create-only production traffic tag bound 100 percent to moderation_adapter_initial_revision on first apply."
}

output "production_plan_service_account" {
  value       = var.production_plan_service_account_email
  description = "Exact private-owned read-only plan GSA with repository-scoped access for second-stage image-witness verification."
}

output "production_moderation_promotion_service_account" {
  value       = var.production_moderation_promotion_service_account_email
  description = "Exact private-owned GSA granted service-scoped production moderation revision and traffic-tag authority."
}

output "production_moderation_promotion_service_role" {
  value       = google_project_iam_custom_role.production_moderation_promotion_service.name
  description = "Custom role with only run.services.get/update, bound on the exact production adapter service."
}

output "moderation_adapter_url" {
  value       = try(google_cloud_run_v2_service.moderation_adapter[0].uri, null)
  description = "Stable authenticated production service URI used only as MESHR_MODERATION_AUDIENCE; endpoint and health URLs must use the verified immutable revision tag URI."
}

output "moderation_adapter_deployed_image" {
  value       = try(google_cloud_run_v2_service.moderation_adapter[0].template[0].containers[0].image, null)
  description = "Currently deployed production adapter image digest. Private promotion owns revision advancement; OpenTofu preserves it and qualification remains read-only."
}

output "moderation_model_armor_template" {
  value       = google_model_armor_template.moderation.name
  description = "Stack-owned regional Model Armor template consumed by both adapters."
}

output "moderation_model_armor_policy_sha256" {
  value       = sha256(jsonencode(local.model_armor_policy))
  description = "SHA-256 fingerprint of Meshr's exact configured Model Armor controls; live qualification must match the underlying fields as well as this expected fingerprint."
}

output "moderation_adapter_canary_service_account" {
  value       = google_service_account.moderation_adapter_canary.email
  description = "Dedicated canary adapter identity holding Model Armor and Sensitive Data Protection permissions."
}

output "moderation_adapter_canary_url" {
  value       = try(google_cloud_run_v2_service.moderation_adapter_canary[0].uri, null)
  description = "Stable authenticated canary service URI used only as the ID-token audience; endpoint and health URLs must use the verified immutable revision tag URI."
}

output "moderation_adapter_canary_initial_revision" {
  value       = var.moderation_adapter_canary_image == null ? null : local.moderation_adapter_canary_revision_name
  description = "Deterministic create-only canary revision name derived from the first 14 characters of moderation_adapter_canary_source_sha to keep its tagged hostname within the DNS label limit."
}

output "moderation_adapter_canary_initial_revision_tag" {
  value       = var.moderation_adapter_canary_image == null ? null : local.moderation_adapter_canary_revision_tag
  description = "Deterministic create-only canary traffic tag bound 100 percent to moderation_adapter_canary_initial_revision on first apply."
}

output "moderation_adapter_canary_deployed_image" {
  value       = try(google_cloud_run_v2_service.moderation_adapter_canary[0].template[0].containers[0].image, null)
  description = "Currently deployed canary adapter image digest. The private workflow owns the create-only service after bootstrap; OpenTofu reads this value without rolling it back."
}

output "event_subscriptions" {
  value = local.event_subscriptions
}

output "firestore_topology_database" {
  value       = google_firestore_database.projections.name
  description = "Aggregate-only Firestore database read by the live gateway."
}

output "firestore_audit_database" {
  value       = google_firestore_database.audit.name
  description = "Dedicated Firestore database for event delivery traces written by the audit worker."
}

output "firestore_notifications_database" {
  value       = google_firestore_database.notifications.name
  description = "Dedicated Firestore database for notification outbox state."
}

output "firestore_moderation_database" {
  value       = google_firestore_database.moderation.name
  description = "Dedicated Firestore database for moderation inbox leases and dead letters."
}

output "firestore_release_audit_database" {
  value       = google_firestore_database.release_audit.name
  description = "Dedicated Firestore database for immutable protected-release cost receipts."
}

output "firestore_canary_release_audit_database" {
  value       = google_firestore_database.canary_release_audit.name
  description = "Dedicated Firestore database for immutable canary-release cost receipts."
}

output "firestore_canary_topology_database" {
  value       = google_firestore_database.canary_projections.name
  description = "Aggregate-only Firestore database read by the canary live gateway."
}

output "firestore_canary_audit_database" {
  value       = google_firestore_database.canary_audit.name
  description = "Dedicated canary Firestore database for event delivery traces."
}

output "firestore_canary_notifications_database" {
  value       = google_firestore_database.canary_notifications.name
  description = "Dedicated canary Firestore database for notification outbox state."
}

output "firestore_canary_moderation_database" {
  value       = google_firestore_database.canary_moderation.name
  description = "Dedicated canary Firestore database for moderation inbox leases and dead letters."
}

output "certificate_map" {
  value       = try(google_certificate_manager_certificate_map.meshr[0].name, null)
  description = "Certificate map created only when launch or DNS management enables the Cloudflare edge."
}

output "cloud_armor_policy" {
  value = google_compute_security_policy.cloud_armor.name
}

output "identity_platform_providers" {
  value = {
    google = length(google_identity_platform_default_supported_idp_config.google) > 0
    github = length(google_identity_platform_default_supported_idp_config.github) > 0
  }
}

output "identity_platform_web_api_key" {
  value     = google_apikeys_key.identity_platform_web.key_string
  sensitive = true
}

output "github_actions_workload_identity_provider" {
  value       = google_iam_workload_identity_pool_provider.github_actions.name
  description = "Artifact-build provider; set as the protected GCP_BUILD_WORKLOAD_IDENTITY_PROVIDER GitHub secret."
}

output "github_actions_deploy_workload_identity_provider" {
  value       = google_iam_workload_identity_pool_provider.github_actions_deploy.name
  description = "Environment/ref/workflow-bound private production-qualification provider; it is not production-promotion authority."
}

output "ci_service_account" {
  value       = google_service_account.ci.email
  description = "Artifact-build service account; set as GCP_BUILD_SERVICE_ACCOUNT."
}

output "ci_deploy_service_account" {
  value       = google_service_account.ci_deploy.email
  description = "Private production-qualification service account; the legacy output name is retained for compatibility."
}

output "github_actions_canary_deploy_workload_identity_provider" {
  value       = try(google_iam_workload_identity_pool_provider.github_actions_canary_deploy[0].name, null)
  description = "Private-repository/environment/ref/manual-workflow-bound canary provider when canary authority is enabled; null for foundation and production-adapter-only stages."
}

output "ci_canary_deploy_service_account" {
  value       = try(google_service_account.ci_canary_deploy[0].email, null)
  description = "Protected canary-deploy service account consumed only by the exact private operations workflow; null when canary authority is disabled."
}
