variable "project_id" {
  type        = string
  description = "GCP project for the Meshr public service."
}

variable "launch_mode" {
  type        = bool
  description = "Set true only for the protected public-launch apply. False keeps provider credentials and billing optional for validation plans."
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
}

variable "cloudflare_api_token" {
  type        = string
  description = "Token with Zone:Read, DNS:Edit, and Zone Settings:Edit permission for the zone."
  sensitive   = true
  default     = null
  nullable    = true
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
