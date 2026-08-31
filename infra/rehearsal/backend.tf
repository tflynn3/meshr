terraform {
  # The bucket is bootstrapped outside this stack so destroying the disposable
  # rehearsal foundation cannot also destroy its recovery history.
  backend "gcs" {
    prefix = "meshr/rehearsal-foundation"
  }
}
