# Meshr private GCP rehearsal foundation

This Terraform stack creates only the durable, low-cost half of a deployment
rehearsal: a short-retention Artifact Registry repository, five disposable
named Firestore databases, one ordered Pub/Sub topology subscription, keyless
GitHub federation, split runtime identities, and a project-scoped $25 monthly
budget alert. It deliberately creates no GKE cluster, load balancer, public IP,
DNS record, certificate, or public service. The `gcp-rehearsal.yml` workflow
owns the ephemeral Autopilot cluster and must delete it in an always-run cleanup
step.

## Bootstrap and remote state

Use a dedicated rehearsal project. Project creation, its billing-account link,
and the remote-state bucket are external bootstrap resources because the stack
must not delete them. The operator needs permission to enable project services,
manage project IAM, create the resources in this directory, and manage budgets
on the selected billing account.

```bash
export TF_VAR_project_id="YOUR_REHEARSAL_PROJECT"
export TF_VAR_billing_account_id="000000-000000-000000"
export REHEARSAL_STATE_BUCKET="YOUR_GLOBALLY_UNIQUE_STATE_BUCKET"

gcloud beta billing projects link "$TF_VAR_project_id" \
  --billing-account="$TF_VAR_billing_account_id"
gcloud services enable serviceusage.googleapis.com storage.googleapis.com \
  --project="$TF_VAR_project_id"
gcloud storage buckets create "gs://$REHEARSAL_STATE_BUCKET" \
  --project="$TF_VAR_project_id" \
  --location="us-central1" \
  --uniform-bucket-level-access
gcloud storage buckets update "gs://$REHEARSAL_STATE_BUCKET" --versioning
```

Restrict bucket IAM to the infrastructure operators. Do not put credentials in
`.tfvars`; Terraform uses Application Default Credentials from `gcloud auth
application-default login`, while GitHub later uses Workload Identity
Federation. This stack never creates a service-account JSON key.

## Plan and apply

```bash
terraform -chdir=infra/rehearsal init \
  -backend-config="bucket=$REHEARSAL_STATE_BUCKET"
terraform -chdir=infra/rehearsal fmt -check
terraform -chdir=infra/rehearsal validate
terraform -chdir=infra/rehearsal plan -out=rehearsal.tfplan
terraform -chdir=infra/rehearsal apply rehearsal.tfplan
terraform -chdir=infra/rehearsal output
```

The numeric GitHub repository and owner IDs default to this repository's
immutable IDs (`1348689949` and `19698887`). The provider accepts only
`workflow_dispatch` or `schedule` tokens from the exact
`tflynn3/meshr/.github/workflows/gcp-rehearsal.yml` path on a branch, and the
OIDC subject must name the protected `gcp-rehearsal` GitHub environment. This
permits only branches allowed by that environment while rejecting tokens from
other workflow files or jobs that omit the environment. Configure GitHub with
the provider and CI service-account outputs, not a key.

The CI service account can push only to `meshr-rehearsal`, consume enabled
services, create/delete GKE clusters inside the dedicated project, and act as
the dedicated node service account. It has `roles/container.admin`, rather than
`roles/container.clusterAdmin`, because the latter can own the cluster lifecycle
but cannot apply the Kubernetes API objects used by the rehearsal deployment.
The node identity can pull only from that repository.

The Google-managed `PROJECT_ID.svc.id.goog` identity pool does not exist until
the first Workload-Identity-enabled GKE cluster exists. The workflow therefore
installs the five KSA-to-GSA `roles/iam.workloadIdentityUser` bindings after it
creates and verifies the Autopilot cluster. A custom role gives CI only
`iam.serviceAccounts.get`, `getIamPolicy`, and `setIamPolicy`, and that role is
bound on only the five rehearsal workload service accounts. The lifecycle
script uses deterministic account names and namespace `meshr-rehearsal`, so the
operation is idempotent and cannot bind an arbitrary service account. Firestore
roles are conditioned to one named database, and Pub/Sub roles are attached to
one topic or subscription.

The budget notifies the billing account's default IAM recipients at 50%, 90%,
and 100% of `monthly_budget_usd` (default `$25`). It is an alert, not a hard cap;
the workflow's always-run cluster deletion is still the overnight cost control.

## Destroy boundary

The routine workflow cleanup deletes only the ephemeral GKE cluster. Keep this
foundation between rehearsals: Artifact Registry cleanup retains at most the
five most recent versions per package after seven days, Pub/Sub retains
unacknowledged events for one day, and no idle GKE control plane remains.

An explicit `terraform destroy` is a separate operator action. It permanently
deletes the five Firestore databases and their data, Pub/Sub messages, images,
IAM bindings, service accounts, and federation pool. Firestore delete
protection is intentionally disabled for this disposable rehearsal stack.
First confirm that the out-of-band cluster has been deleted; Terraform cannot
see or remove it. Destroy leaves the GCP project, billing link, remote-state
bucket/history, and enabled APIs in place.
