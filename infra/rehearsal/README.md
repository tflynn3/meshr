# Meshr private GCP rehearsal foundation

This Terraform stack creates only the durable, low-cost half of a deployment
rehearsal: a short-retention Artifact Registry repository, five disposable
named Firestore databases, one ordered Pub/Sub topology subscription, keyless
GitHub federation, split runtime identities, and a project-scoped $25 monthly
budget alert. It deliberately creates no GKE cluster, load balancer, public IP,
DNS record, certificate, or public service. A protected workflow in the private
operations repository owns the ephemeral Autopilot cluster and its bounded
cleanup lifecycle. The public application repository contains no hosted
rehearsal or cloud-deployment workflow.

## Bootstrap and remote state

Use a dedicated rehearsal project. Project creation, its billing-account link,
and the remote-state bucket are external bootstrap resources because the stack
must not delete them. The operator needs permission to enable project services,
manage project IAM, create the resources in this directory, and manage budgets
on the selected billing account.

```bash
export TF_VAR_project_id="YOUR_REHEARSAL_PROJECT"
export TF_VAR_billing_account_id="000000-000000-000000"
export TF_VAR_github_repository="OWNER/meshr-ops"
export TF_VAR_github_repository_id="IMMUTABLE_PRIVATE_REPOSITORY_ID"
export TF_VAR_github_repository_owner_id="IMMUTABLE_OWNER_ID"
export TF_VAR_github_workflow_path=".github/workflows/deploy.yml"
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
Federation. Set the ADC quota project to the rehearsal project so a stale local
quota project cannot make the GCS backend fail even when bucket IAM is correct:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project "$TF_VAR_project_id"
```

This stack never creates a service-account JSON key.

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

There is one fresh-project bootstrap boundary. Google's managed
`PROJECT_ID.svc.id.goog` pool does not exist until the first
Workload-Identity-enabled GKE cluster has existed, and GKE then retains the pool
after cluster deletion. On a brand-new project only, replace the normal plan and
apply above with this bounded bootstrap sequence:

```bash
terraform -chdir=infra/rehearsal plan \
  -var=workload_identity_bindings_enabled=false \
  -out=rehearsal-bootstrap.tfplan
terraform -chdir=infra/rehearsal apply rehearsal-bootstrap.tfplan

export GCP_PROJECT_ID="$TF_VAR_project_id"
export GCP_REGION="us-central1"
export GKE_CLUSTER="meshr-rehearsal"
export NODE_SERVICE_ACCOUNT="$(terraform -chdir=infra/rehearsal output -raw gke_node_service_account_email)"
bash scripts/gcp-rehearsal.sh create-cluster
bash scripts/gcp-rehearsal.sh destroy-cluster

terraform -chdir=infra/rehearsal plan -out=rehearsal.tfplan
terraform -chdir=infra/rehearsal apply rehearsal.tfplan
```

The destroy command validates the cluster's name, region, Autopilot mode,
Workload Identity pool, and rehearsal labels before deletion. Subsequent plans
and rehearsals require no bootstrap exception.

The GitHub repository name, numeric repository/owner IDs, and workflow path are
required, non-secret inputs. The exports above set all four to the private
operations repository so only its protected workflow can deploy. If you use a
checked local variable file instead, give it the equivalent values:

```hcl
github_repository          = "OWNER/meshr-ops"
github_repository_id       = "IMMUTABLE_PRIVATE_REPOSITORY_ID"
github_repository_owner_id = "IMMUTABLE_OWNER_ID"
github_workflow_path        = ".github/workflows/deploy.yml"
```

The provider accepts only `workflow_dispatch` or `schedule` tokens from that
exact workflow on `main`. The OIDC subject must name the protected
`gcp-rehearsal` GitHub environment. This rejects pushes, branch variants, other
workflow paths, and jobs that omit the environment. Configure GitHub with the
provider and CI service-account outputs, not a key.

GitHub repositories created after 2026-07-15 use an immutable default OIDC
subject that embeds both numeric IDs. Keep the provider subject in the form
`repo:OWNER@OWNER_ID/REPOSITORY@REPOSITORY_ID:environment:gcp-rehearsal`; the
older name-only subject is rejected even though the separate numeric claim
checks still pass.

The CI service account can push only to `meshr-rehearsal`, consume enabled
services, create/delete GKE clusters inside the dedicated project, and act as
the dedicated node service account. It has `roles/container.admin`, rather than
`roles/container.clusterAdmin`, because the latter can own the cluster lifecycle
but cannot apply the Kubernetes API objects used by the rehearsal deployment.
The node identity can pull only from that repository.

After that one-time pool bootstrap, Terraform owns five exact, stable
KSA-to-GSA `roles/iam.workloadIdentityUser` bindings. Deployment CI cannot
rewrite workload service-account policy or impersonate those service accounts.
Firestore roles are conditioned to one named database, and Pub/Sub roles are
attached to one topic or subscription. The topology identity additionally has
metadata-read permission on only its own subscription because the runtime
readiness contract verifies that subscription before reporting ready.

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
