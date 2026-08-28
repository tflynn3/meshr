variable "project_id" {
  type        = string
  description = "GCP project for the Meshr public service."
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
  description = "Token with scoped DNS edit permission for the zone."
  sensitive   = true
}

variable "production_image" {
  type        = string
  description = "Immutable API/event-plane image digest promoted by CI."
  default     = null
  nullable    = true
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
