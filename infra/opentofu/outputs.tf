output "cluster_name" {
  value = google_container_cluster.autopilot.name
}

output "region" {
  value = var.region
}

output "gateway_ip" {
  value       = google_compute_global_address.gateway.address
  description = "Reserved global IPv4 address used by the production GKE Gateway and root Cloudflare record."
}

output "staging_gateway_ip" {
  value       = google_compute_global_address.staging_gateway.address
  description = "Reserved global IPv4 address used by the independent canary Gateway and staging Cloudflare record."
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

output "event_subscriptions" {
  value = local.event_subscriptions
}

output "firestore_topology_database" {
  value       = google_firestore_database.projections.name
  description = "Aggregate-only Firestore database read by the live gateway."
}

output "firestore_canary_topology_database" {
  value       = google_firestore_database.canary_projections.name
  description = "Aggregate-only Firestore database read by the canary live gateway."
}

output "certificate_map" {
  value = google_certificate_manager_certificate_map.meshr.name
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
  description = "Environment/ref/workflow-bound production provider; set as GCP_DEPLOY_WORKLOAD_IDENTITY_PROVIDER."
}

output "ci_service_account" {
  value       = google_service_account.ci.email
  description = "Artifact-build service account; set as GCP_BUILD_SERVICE_ACCOUNT."
}

output "ci_deploy_service_account" {
  value       = google_service_account.ci_deploy.email
  description = "Protected production-deploy service account; set as GCP_DEPLOY_SERVICE_ACCOUNT."
}

output "github_actions_canary_deploy_workload_identity_provider" {
  value       = google_iam_workload_identity_pool_provider.github_actions_canary_deploy.name
  description = "Environment/ref/workflow-bound canary provider; set as GCP_CANARY_DEPLOY_WORKLOAD_IDENTITY_PROVIDER."
}

output "ci_canary_deploy_service_account" {
  value       = google_service_account.ci_canary_deploy.email
  description = "Protected canary-deploy service account; set as GCP_CANARY_DEPLOY_SERVICE_ACCOUNT."
}
