terraform {
  # Keep production state out of a workstation checkout. The bucket is
  # intentionally supplied at `tofu init` time because creating the bucket
  # that stores this state from the same configuration would be a bootstrap
  # cycle. Operators must use a dedicated, versioned GCS bucket with Object
  # Versioning and uniform bucket-level access enabled.
  backend "gcs" {
    prefix = "meshr/production"
  }
}
