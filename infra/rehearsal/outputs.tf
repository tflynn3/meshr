output "project_id" {
  value       = var.project_id
  description = "Dedicated rehearsal project."
}

output "region" {
  value       = var.region
  description = "Rehearsal data and ephemeral-cluster region."
}

output "monthly_budget_usd" {
  value       = var.monthly_budget_usd
  description = "Project-scoped monthly alert amount; this is not a hard spending cap."
}

output "kubernetes_namespace" {
  value       = local.kubernetes_namespace
  description = "Namespace whose Kubernetes service accounts may impersonate the rehearsal workload identities."
}

output "artifact_registry_repository" {
  value       = google_artifact_registry_repository.images.name
  description = "Artifact Registry repository ID."
}

output "artifact_registry_url" {
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.name}"
  description = "OCI registry prefix used by the rehearsal build."
}

output "firestore_database_ids" {
  value = {
    for key, database in google_firestore_database.database : key => database.name
  }
  description = "Named Firestore databases selected by the rehearsal runtime."
}

output "pubsub_topic" {
  value       = google_pubsub_topic.events.name
  description = "Event topic published by the rehearsal ingest worker."
}

output "pubsub_topology_subscription" {
  value       = google_pubsub_subscription.topology.name
  description = "Subscription consumed by the rehearsal topology materializer."
}

output "github_actions_workload_identity_provider" {
  value       = google_iam_workload_identity_pool_provider.github.name
  description = "Provider resource name for google-github-actions/auth; no JSON key is required."
}

output "ci_service_account_email" {
  value       = google_service_account.ci.email
  description = "Keyless GitHub Actions identity allowed to push images and own the ephemeral cluster lifecycle."
}

output "gke_node_service_account_email" {
  value       = google_service_account.gke_nodes.email
  description = "Node identity passed to GKE Autopilot cluster creation."
}

output "workload_service_accounts" {
  value = {
    for key, account in google_service_account.workload : key => account.email
  }
  description = "Google service-account emails used in the rehearsal Kubernetes ServiceAccount annotations."
}

output "kubernetes_service_account_annotations" {
  value = {
    for key, account in local.workload_accounts :
    account.kubernetes_service_account => google_service_account.workload[key].email
  }
  description = "Kubernetes ServiceAccount name to iam.gke.io/gcp-service-account annotation value."
}
