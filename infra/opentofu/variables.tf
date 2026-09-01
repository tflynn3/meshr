variable "project_id" {
  type        = string
  description = "GCP project for the Meshr public service."
}

variable "launch_mode" {
  type        = bool
  description = "Set true only for the protected public-launch apply. False keeps provider credentials and billing optional for validation plans."
  default     = false
}

variable "organization_policy_guardrails_enabled" {
  type        = bool
  description = "Enforce the five project-level Organization Policy guardrails. Defaults true and may be false only for a non-public qualification apply with launch and both DNS-management flags disabled; public launch requires an organization-backed project and this value true."
  default     = true
}

variable "private_moderation_adapter_mode" {
  type        = bool
  description = "Explicitly allow a separately reviewed OpenTofu apply to create or advance only the authenticated production moderation adapter while launch_mode=false. DNS, Cloudflare, OAuth, and the canary adapter must remain disabled."
  default     = false
}

variable "accept_projection_marker_writer_risk" {
  type        = bool
  description = "Explicit security-owner acceptance that the topology materializer has database-scoped write access and could technically mutate the projection bootstrap marker. Required for launch_mode=true or production DNS management until the marker is moved to a separately restricted attestation service/database."
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
    condition = var.cloudflare_origin_secret == null ? true : (
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
  description = "Immutable Cloud Run image digest for the Model Armor/Sensitive Data Protection moderation adapter. The adapter must expose authenticated /health and /screen endpoints. Required for launch_mode=true or private_moderation_adapter_mode=true; null keeps validation plans resource-free."
  default     = null
  nullable    = true

  validation {
    condition = var.moderation_adapter_image == null || can(
      regex("^.+@sha256:[a-f0-9]{64}$", trimspace(var.moderation_adapter_image)),
    )
    error_message = "moderation_adapter_image must be null or an immutable image reference ending in @sha256:<64 lowercase hex characters>."
  }
}

variable "moderation_adapter_source_sha" {
  type        = string
  description = "Exact 40-character public source commit whose signed multi-platform image witness resolves moderation_adapter_image. It must be set exactly when a production adapter image is supplied; adapter-free foundation plans leave both null."
  default     = null
  nullable    = true

  validation {
    condition = (
      var.moderation_adapter_source_sha == null ||
      can(regex("^[a-f0-9]{40}$", var.moderation_adapter_source_sha))
    )
    error_message = "moderation_adapter_source_sha must be null or exactly 40 lowercase hexadecimal characters."
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

variable "moderation_adapter_canary_source_sha" {
  type        = string
  description = "Exact 40-character public source commit whose signed multi-platform image witness resolves moderation_adapter_canary_image. It must be set exactly when a canary adapter image is supplied."
  default     = null
  nullable    = true

  validation {
    condition = (
      var.moderation_adapter_canary_source_sha == null ||
      can(regex("^[a-f0-9]{40}$", var.moderation_adapter_canary_source_sha))
    )
    error_message = "moderation_adapter_canary_source_sha must be null or exactly 40 lowercase hexadecimal characters."
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
  description = "Sensitive Data Protection processing location used by the moderation adapter. It must equal region whenever either adapter is deployed."
  default     = "us-central1"
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
  description = "Canonical GitHub owner/repository that builds release artifacts. Pair it with the immutable numeric repository and owner IDs."

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must use the OWNER/REPOSITORY form."
  }
}

variable "github_repository_id" {
  type        = string
  description = "Immutable numeric GitHub repository ID allowed to federate into the artifact-build identity."

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_id))
    error_message = "github_repository_id must contain only decimal digits."
  }
}

variable "github_repository_owner_id" {
  type        = string
  description = "Immutable numeric GitHub repository-owner ID allowed to federate into the artifact-build identity."

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_owner_id))
    error_message = "github_repository_owner_id must contain only decimal digits."
  }
}

variable "github_build_workflow_path" {
  type        = string
  description = "Repository-relative GitHub Actions workflow path allowed to mint the artifact-build identity."
  default     = ".github/workflows/ci.yml"

  validation {
    condition = (
      can(regex("^\\.github/workflows/[A-Za-z0-9_./-]+\\.ya?ml$", var.github_build_workflow_path)) &&
      !strcontains(var.github_build_workflow_path, "..")
    )
    error_message = "github_build_workflow_path must name one YAML workflow below .github/workflows without parent traversal."
  }
}

variable "github_deploy_identity" {
  type = object({
    repository          = string
    repository_id       = string
    repository_owner_id = string
    workflow_path       = string
  })
  description = "Explicit private GitHub repository identity allowed to promote canary. Required only when launch_mode or a canary adapter digest/source pair enables canary authority; foundation and production-adapter-only plans leave it null. The public build repository is never a deploy fallback."
  default     = null
  nullable    = true

  validation {
    condition = var.github_deploy_identity == null ? true : (
      can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_deploy_identity.repository)) &&
      can(regex("^[0-9]+$", var.github_deploy_identity.repository_id)) &&
      can(regex("^[0-9]+$", var.github_deploy_identity.repository_owner_id)) &&
      can(regex("^\\.github/workflows/[A-Za-z0-9_./-]+\\.ya?ml$", var.github_deploy_identity.workflow_path)) &&
      !strcontains(var.github_deploy_identity.workflow_path, "..")
    )
    error_message = "github_deploy_identity must be null when canary authority is disabled, or explicitly provide a private OWNER/REPOSITORY, decimal repository and owner IDs, and one YAML workflow below .github/workflows without parent traversal."
  }
}

variable "github_production_deploy_identity" {
  type = object({
    repository          = string
    repository_id       = string
    repository_owner_id = string
    workflow_path       = string
  })
  description = "Explicit private GitHub repository identity allowed to qualify production. Protected production plans must supply immutable repository and owner IDs plus one exact workflow path."
  nullable    = false

  validation {
    condition = (
      can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_production_deploy_identity.repository)) &&
      can(regex("^[0-9]+$", var.github_production_deploy_identity.repository_id)) &&
      can(regex("^[0-9]+$", var.github_production_deploy_identity.repository_owner_id)) &&
      can(regex("^\\.github/workflows/[A-Za-z0-9_./-]+\\.ya?ml$", var.github_production_deploy_identity.workflow_path)) &&
      !strcontains(var.github_production_deploy_identity.workflow_path, "..")
    )
    error_message = "github_production_deploy_identity must provide OWNER/REPOSITORY, decimal repository and owner IDs, and one YAML workflow below .github/workflows without parent traversal."
  }
}

variable "ci_service_account_id" {
  type        = string
  description = "Stable account ID for the GitHub Actions artifact-build identity."
  default     = "meshr-ci"
}

variable "ci_deploy_service_account_id" {
  type        = string
  description = "Stable account ID for the private production-qualification identity. The legacy variable name does not grant production-promotion authority."
  default     = "meshr-ci-deploy"
}

variable "connect_gateway_deploy_service_account_email" {
  type        = string
  description = "Exact production-qualification service-account email authorized through GKE Connect Gateway. This public stack defines its cloud-side WIF trust; the referenced private workflow and protected apply control executable authority."

  validation {
    condition = can(regex(
      "^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\\.iam\\.gserviceaccount\\.com$",
      var.connect_gateway_deploy_service_account_email,
    ))
    error_message = "connect_gateway_deploy_service_account_email must be one exact Google service-account email, not a user, group, principal set, or wildcard."
  }
}

variable "production_plan_service_account_email" {
  type        = string
  description = "Exact existing private-operations meshr-prod-plan GSA allowed to read only the Meshr Artifact Registry repository for the second-stage production image-witness plan. The private stack owns this GSA and its read-only workflow-bound WIF trust."
  nullable    = false

  validation {
    condition = (
      var.production_plan_service_account_email == trimspace(var.production_plan_service_account_email) &&
      can(regex(
        "^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\\.iam\\.gserviceaccount\\.com$",
        var.production_plan_service_account_email,
      ))
    )
    error_message = "production_plan_service_account_email must be one exact Google service-account email without whitespace; the stack guard further pins meshr-prod-plan in project_id."
  }
}

variable "production_moderation_promotion_service_account_email" {
  type        = string
  description = "Exact existing private-operations meshr-ci-promote GSA allowed to update only the production moderation-adapter service, read its exact Artifact Registry repository, and act as only the adapter runtime identity. The private stack owns this GSA and its workflow/ref/environment/manual-dispatch-bound WIF trust."
  nullable    = false

  validation {
    condition = (
      var.production_moderation_promotion_service_account_email == trimspace(var.production_moderation_promotion_service_account_email) &&
      can(regex(
        "^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\\.iam\\.gserviceaccount\\.com$",
        var.production_moderation_promotion_service_account_email,
      ))
    )
    error_message = "production_moderation_promotion_service_account_email must be one exact Google service-account email without whitespace; the stack guard further pins meshr-ci-promote in project_id."
  }
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
