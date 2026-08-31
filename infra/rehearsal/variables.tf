variable "project_id" {
  type        = string
  description = "Dedicated GCP project used only for private Meshr rehearsals."

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a valid 6-30 character lowercase GCP project ID."
  }
}

variable "region" {
  type        = string
  description = "Region shared by the durable rehearsal data plane and ephemeral GKE cluster."
  default     = "us-central1"

  validation {
    condition     = var.region == "us-central1"
    error_message = "The rehearsal foundation is intentionally pinned to us-central1."
  }
}

variable "billing_account_id" {
  type        = string
  description = "Billing account linked to the dedicated rehearsal project during external bootstrap. The stack records but does not own the project-to-billing association."

  validation {
    condition     = can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", var.billing_account_id))
    error_message = "billing_account_id must use the six-six-six form, for example 000000-000000-000000."
  }
}

variable "monthly_budget_usd" {
  type        = number
  description = "Monthly project-scoped rehearsal budget alert in USD. GCP budgets notify; they do not cap spend."
  default     = 25

  validation {
    condition     = var.monthly_budget_usd > 0 && floor(var.monthly_budget_usd) == var.monthly_budget_usd
    error_message = "monthly_budget_usd must be a positive whole-dollar amount."
  }
}

variable "github_repository_id" {
  type        = string
  description = "Immutable numeric GitHub repository ID allowed to federate into the rehearsal CI identity."
  default     = "1348689949"

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_id))
    error_message = "github_repository_id must contain only decimal digits."
  }
}

variable "github_repository_owner_id" {
  type        = string
  description = "Immutable numeric GitHub repository-owner ID allowed to federate into the rehearsal CI identity."
  default     = "19698887"

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_owner_id))
    error_message = "github_repository_owner_id must contain only decimal digits."
  }
}
