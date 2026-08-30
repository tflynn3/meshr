variable "project_id" {
  type        = string
  description = "GCP project for the Meshr public service."
}

variable "launch_mode" {
  type        = bool
  description = "Set true only for the protected public-launch apply. False keeps provider credentials and billing optional for validation plans."
  default     = false
}

variable "accept_worker_authority_database_risk" {
  type        = bool
  description = "Explicit security-owner acceptance that current workers receive database-scoped Firestore access because predefined IAM roles cannot isolate collections. Required for launch_mode=true or production DNS management; set false while the boundary is unreviewed."
  default     = false
}

variable "region" {
  type        = string
  description = "Single regional launch location."
  default     = "us-central1"
}

variable "zone_name" {
  type        = string
  description = "Cloudflare DNS zone name, without a trailing dot."
  default     = "meshr.social"

  validation {
    condition     = var.zone_name == trimspace(var.zone_name) && can(regex("^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$", var.zone_name))
    error_message = "zone_name must be a DNS name with at least two labels and no trailing dot."
  }
}

variable "cloudflare_api_token" {
  type        = string
  description = "Token with Zone:Read, DNS:Edit, Zone Settings:Edit, Zone Transform Rules:Edit, and Account Rulesets:Read permission for the zone."
  sensitive   = true
  default     = null
  nullable    = true
}

variable "cloudflare_origin_secret" {
  type        = string
  description = "High-entropy secret that Cloudflare's zone transform rule adds to proxied requests and Cloud Armor requires at the GCP origin. Keep it in the protected OpenTofu variable/state; never put it in browser or workload configuration."
  sensitive   = true
  default     = null
  nullable    = true

  validation {
    condition = var.cloudflare_origin_secret == null || (
      var.cloudflare_origin_secret == trimspace(var.cloudflare_origin_secret) && can(
        regex("^[A-Za-z0-9_-]{32,128}$", var.cloudflare_origin_secret),
      )
    )
    error_message = "cloudflare_origin_secret must be null or a 32-128 character URL-safe high-entropy value."
  }
}

variable "manage_production_dns_records" {
  type        = bool
  description = "Opt in to the meshr.social production DNS record only after importing/verifying the existing record and Gateway certificate."
  default     = false
}

variable "manage_staging_dns_records" {
  type        = bool
  description = "Opt in to the staging.meshr.social canary DNS record after verifying the independent staging Gateway certificate."
  default     = false
}

variable "production_image" {
  type        = string
  description = "Immutable API/event-plane image digest promoted by CI."
  default     = null
  nullable    = true
}

variable "moderation_adapter_image" {
  type        = string
  description = "Immutable Cloud Run image digest for the Model Armor/Sensitive Data Protection moderation adapter. The adapter must expose authenticated /healthz and /screen endpoints. Required for launch_mode=true; null keeps validation plans resource-free."
  default     = null
  nullable    = true

  validation {
    condition = var.moderation_adapter_image == null || can(
      regex("^.+@sha256:[a-f0-9]{64}$", trimspace(var.moderation_adapter_image)),
    )
    error_message = "moderation_adapter_image must be null or an immutable image reference ending in @sha256:<64 lowercase hex characters>."
  }
}

variable "moderation_adapter_canary_image" {
  type        = string
  description = "Immutable Cloud Run image digest for the canary moderation adapter. Keep this separate from the production adapter so canary promotion cannot update both services at once. Required for launch_mode=true."
  default     = null
  nullable    = true

  validation {
    condition = var.moderation_adapter_canary_image == null || can(
      regex("^.+@sha256:[a-f0-9]{64}$", trimspace(var.moderation_adapter_canary_image)),
    )
    error_message = "moderation_adapter_canary_image must be null or an immutable image reference ending in @sha256:<64 lowercase hex characters>."
  }
}

variable "moderation_model_armor_template" {
  type        = string
  description = "Fully qualified Model Armor template resource used by the moderation adapter. Required for launch_mode=true."
  default     = null
  nullable    = true

  validation {
    condition = var.moderation_model_armor_template == null || can(
      regex("^projects/[A-Za-z0-9][A-Za-z0-9-_.:]{0,99}/locations/[A-Za-z0-9][A-Za-z0-9-_.-]{0,62}/templates/[A-Za-z0-9][A-Za-z0-9-_.-]{0,99}$", trimspace(var.moderation_model_armor_template)),
    )
    error_message = "moderation_model_armor_template must be null or a fully qualified projects/<project>/locations/<location>/templates/<template> resource."
  }
}

variable "moderation_model_armor_endpoint" {
  type        = string
  description = "Optional HTTPS Model Armor API endpoint override; leave null to derive the regional rep.googleapis.com endpoint."
  default     = null
  nullable    = true

  validation {
    condition = var.moderation_model_armor_endpoint == null || can(
      regex("^https://modelarmor\\.[A-Za-z0-9][A-Za-z0-9.-]*\\.rep\\.googleapis\\.com/?$|^https://modelarmor\\.googleapis\\.com/?$", trimspace(var.moderation_model_armor_endpoint)),
    )
    error_message = "moderation_model_armor_endpoint must be the regional modelarmor.<location>.rep.googleapis.com endpoint (or the global Model Armor endpoint) over HTTPS."
  }
}

variable "moderation_dlp_location" {
  type        = string
  description = "Sensitive Data Protection processing location used by the moderation adapter."
  default     = "global"
  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9-_.-]{0,62}$", trimspace(var.moderation_dlp_location)))
    error_message = "moderation_dlp_location must be a valid Google Cloud location name."
  }
}

variable "gateway_hostname" {
  type        = string
  description = "Deprecated compatibility input; the stack now reserves and publishes a static global Gateway address."
  default     = null
  nullable    = true
}

variable "billing_account_id" {
  type        = string
  description = "GCP billing account ID for the launch budget alerts. Leave null only for a dry infrastructure plan."
  default     = null
  nullable    = true
}

variable "monthly_budget_usd" {
  type        = number
  description = "Alert target; GCP budgets are alerts, not a hard spend cap."
  default     = 250
}

variable "alert_notification_email" {
  type        = string
  description = "Operations email that receives Cloud Monitoring alert policies and budget notifications. Required for launch_mode=true; null keeps validation plans provider-resource free."
  sensitive   = true
  default     = null
  nullable    = true

  validation {
    condition = var.alert_notification_email == null || can(
      regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", trimspace(var.alert_notification_email)),
    )
    error_message = "alert_notification_email must be a valid email address or null."
  }
}

variable "additional_authority_database_names" {
  type        = set(string)
  description = "Optional Firestore database IDs temporarily authorized for a restore cutover. The managed (default) database is always included; remove a cutover ID after the restore is retired."
  default     = []

  validation {
    condition = alltrue([
      for value in var.additional_authority_database_names :
      can(regex("^[A-Za-z][A-Za-z0-9_-]{0,62}$", trimspace(value))) && trimspace(value) != "(default)"
    ])
    error_message = "additional_authority_database_names must contain Firestore database IDs (letters, numbers, hyphens, or underscores); (default) is implicit."
  }
}

variable "additional_topology_database_names" {
  type        = set(string)
  description = "Optional Firestore topology database IDs temporarily authorized for a projection restore cutover. The managed projections database is always included; remove a cutover ID after the restore is retired."
  default     = []

  validation {
    condition = alltrue([
      for value in var.additional_topology_database_names :
      can(regex("^[A-Za-z][A-Za-z0-9_-]{0,62}$", trimspace(value))) && trimspace(value) != "(default)"
    ])
    error_message = "additional_topology_database_names must contain Firestore database IDs (letters, numbers, hyphens, or underscores); (default) is implicit."
  }
}

variable "google_oauth_client_id" {
  type        = string
  description = "Google OAuth client ID registered for Identity Platform. Leave null for a dry infrastructure plan."
  sensitive   = true
  default     = null
  nullable    = true
}

variable "google_oauth_client_secret" {
  type        = string
  description = "Google OAuth client secret registered for Identity Platform. Leave null for a dry infrastructure plan."
  sensitive   = true
  default     = null
  nullable    = true
}

variable "github_oauth_client_id" {
  type        = string
  description = "GitHub OAuth client ID registered for Identity Platform. Leave null for a dry infrastructure plan."
  sensitive   = true
  default     = null
  nullable    = true
}

variable "github_oauth_client_secret" {
  type        = string
  description = "GitHub OAuth client secret registered for Identity Platform. Leave null for a dry infrastructure plan."
  sensitive   = true
  default     = null
  nullable    = true
}

variable "github_repository" {
  type        = string
  description = "GitHub owner/repository allowed to mint CI Workload Identity Federation tokens."
  default     = "tflynn3/meshr"
}

variable "ci_service_account_id" {
  type        = string
  description = "Stable account ID for the GitHub Actions artifact-build identity."
  default     = "meshr-ci"
}

variable "ci_deploy_service_account_id" {
  type        = string
  description = "Stable account ID for the protected GitHub Actions production-deploy identity."
  default     = "meshr-ci-deploy"
}

variable "ci_canary_deploy_service_account_id" {
  type        = string
  description = "Stable account ID for the protected GitHub Actions canary-deploy identity."
  default     = "meshr-ci-canary"
}

variable "gke_node_service_account_id" {
  type        = string
  description = "Dedicated least-privilege service account used by GKE Autopilot node VMs to pull Meshr images."
  default     = "meshr-gke-nodes"
}

variable "gke_control_plane_authorized_cidrs" {
  type = list(object({
    cidr_block   = string
    display_name = string
  }))
  description = "Fixed-egress operator or CI CIDRs allowed to reach the GKE control plane. Do not use GitHub-hosted runner ranges or 0.0.0.0/0."

  validation {
    condition = length(var.gke_control_plane_authorized_cidrs) > 0 && alltrue([
      for entry in var.gke_control_plane_authorized_cidrs :
      can(cidrhost(entry.cidr_block, 0)) &&
      trimspace(entry.display_name) != "" &&
      entry.cidr_block != "0.0.0.0/0" &&
      entry.cidr_block != "::/0"
    ])
    error_message = "Provide at least one valid fixed-egress CIDR with a display name; 0.0.0.0/0 and ::/0 are not permitted."
  }
}
