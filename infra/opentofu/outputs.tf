output "cluster_name" {
  value = google_container_cluster.autopilot.name
}

output "region" {
  value = var.region
}

output "gateway_ip" {
  value       = google_compute_global_address.gateway.address
  description = "Reserved global IPv4 address used by the GKE Gateway and Cloudflare A records."
}

output "artifact_registry" {
  value = google_artifact_registry_repository.images.name
}

output "api_service_account" {
  value = google_service_account.api.email
}

output "event_plane_service_account" {
  value = google_service_account.event_plane.email
}

output "ingest_service_account" {
  value = google_service_account.ingest.email
}

output "event_subscriptions" {
  value = local.event_subscriptions
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
