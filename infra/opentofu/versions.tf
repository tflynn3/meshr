terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "cloudflare" {
  # The v4 provider requires one credential even when every Cloudflare
  # resource has count=0. Keep credential-free validation plans runnable with
  # a deliberately unusable local value; the launch guard requires the real
  # protected token before any Cloudflare resource can exist.
  api_token = local.cloudflare_enabled ? var.cloudflare_api_token : "0000000000000000000000000000000000000000"
}
