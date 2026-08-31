#!/usr/bin/env bash
set -euo pipefail

namespace="meshr-rehearsal"
repo_root="$(builtin cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null && pwd -P)"
project_id="${GCP_PROJECT_ID:-}"
region="${GCP_REGION:-us-central1}"
cluster_name="${GKE_CLUSTER:-meshr-rehearsal}"
kube_context="gke_${project_id}_${region}_${cluster_name}"
cluster_labels="app=meshr,environment=rehearsal,lifecycle=ephemeral"

api_port="${MESHR_REHEARSAL_API_PORT:-18787}"
web_port="${MESHR_REHEARSAL_WEB_PORT:-18080}"
ingest_port="${MESHR_REHEARSAL_INGEST_PORT:-18081}"
live_port="${MESHR_REHEARSAL_LIVE_PORT:-18082}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

require_project() {
  if [[ -z "$project_id" ]]; then
    echo "GCP_PROJECT_ID is required" >&2
    exit 1
  fi
}

cluster_json() {
  gcloud container clusters describe "$cluster_name" \
    --project "$project_id" \
    --region "$region" \
    --format=json
}

cluster_presence() {
  local error_file status
  error_file="$(mktemp "${TMPDIR:-/tmp}/meshr-cluster-probe.XXXXXX")"
  if gcloud container clusters describe "$cluster_name" \
    --project "$project_id" \
    --region "$region" \
    --format='value(name)' >/dev/null 2>"$error_file"; then
    rm -f "$error_file"
    echo "present"
    return 0
  else
    status=$?
  fi

  # A missing cluster is the only failure that is safe to reinterpret as
  # absence. Authentication, authorization, API, quota, and network failures
  # must stop both creation and teardown so CI cannot claim cleanup succeeded
  # while a paid cluster may still be running.
  if grep -Eq 'ResponseError: code=404|(^|[^A-Z_])NOT_FOUND([^A-Z_]|$)' "$error_file"; then
    rm -f "$error_file"
    echo "absent"
    return 0
  fi

  cat "$error_file" >&2
  rm -f "$error_file"
  echo "unable to determine GKE rehearsal cluster presence" >&2
  return "$status"
}

assert_rehearsal_cluster() {
  local description="${1:-}"
  if [[ -z "$description" ]]; then
    description="$(cluster_json)"
  fi
  if ! jq -e \
    --arg project "$project_id" \
    --arg region "$region" \
    --arg pool "${project_id}.svc.id.goog" \
    '.name != null
      and .location == $region
      and .autopilot.enabled == true
      and .workloadIdentityConfig.workloadPool == $pool
      and .resourceLabels.app == "meshr"
      and .resourceLabels.environment == "rehearsal"
      and .resourceLabels.lifecycle == "ephemeral"' \
    >/dev/null <<<"$description"; then
    echo "refusing to operate on cluster without the complete Meshr rehearsal identity" >&2
    return 1
  fi
}

connect_cluster() {
  require_project
  require_command gcloud
  require_command jq
  local presence
  presence="$(cluster_presence)"
  if [[ "$presence" == "absent" ]]; then
    echo "GKE rehearsal cluster does not exist: $cluster_name ($region)" >&2
    return 1
  fi
  assert_rehearsal_cluster "$(cluster_json)"
  gcloud container clusters get-credentials "$cluster_name" \
    --project "$project_id" \
    --region "$region" >/dev/null
}

k() {
  kubectl --context "$kube_context" "$@"
}

create_cluster() {
  require_project
  require_command gcloud
  require_command jq
  local node_service_account presence
  node_service_account="${MESHR_REHEARSAL_NODE_GSA:-${NODE_SERVICE_ACCOUNT:-meshr-rehearsal-gke-nodes@${project_id}.iam.gserviceaccount.com}}"
  presence="$(cluster_presence)"
  if [[ "$presence" == "present" ]]; then
    assert_rehearsal_cluster "$(cluster_json)"
    echo "Meshr rehearsal cluster already exists: $cluster_name"
  else
    gcloud container clusters create-auto "$cluster_name" \
      --project "$project_id" \
      --region "$region" \
      --release-channel regular \
      --service-account "$node_service_account" \
      --labels "$cluster_labels" \
      --quiet
    assert_rehearsal_cluster "$(cluster_json)"
  fi
  gcloud container clusters get-credentials "$cluster_name" \
    --project "$project_id" \
    --region "$region" >/dev/null
  echo "Meshr Autopilot rehearsal cluster is ready: $cluster_name ($region)"
}

set_workload_identity_values() {
  export MESHR_REHEARSAL_API_GSA="${MESHR_REHEARSAL_API_GSA:-meshr-rehearsal-api@${project_id}.iam.gserviceaccount.com}"
  export MESHR_REHEARSAL_BOOTSTRAP_GSA="${MESHR_REHEARSAL_BOOTSTRAP_GSA:-meshr-rehearsal-bootstrap@${project_id}.iam.gserviceaccount.com}"
  export MESHR_REHEARSAL_INGEST_GSA="${MESHR_REHEARSAL_INGEST_GSA:-meshr-rehearsal-ingest@${project_id}.iam.gserviceaccount.com}"
  export MESHR_REHEARSAL_TOPOLOGY_GSA="${MESHR_REHEARSAL_TOPOLOGY_GSA:-meshr-rehearsal-topology@${project_id}.iam.gserviceaccount.com}"
  export MESHR_REHEARSAL_LIVE_GSA="${MESHR_REHEARSAL_LIVE_GSA:-meshr-rehearsal-live@${project_id}.iam.gserviceaccount.com}"
}

set_render_values() {
  set_workload_identity_values

  export MESHR_REHEARSAL_AUTHORITY_DATABASE="${MESHR_REHEARSAL_AUTHORITY_DATABASE:-meshr-rehearsal-authority}"
  export MESHR_REHEARSAL_TOPOLOGY_DATABASE="${MESHR_REHEARSAL_TOPOLOGY_DATABASE:-meshr-rehearsal-projections}"
  export MESHR_REHEARSAL_AUDIT_DATABASE="${MESHR_REHEARSAL_AUDIT_DATABASE:-meshr-rehearsal-audit}"
  export MESHR_REHEARSAL_NOTIFICATIONS_DATABASE="${MESHR_REHEARSAL_NOTIFICATIONS_DATABASE:-meshr-rehearsal-notifications}"
  export MESHR_REHEARSAL_MODERATION_DATABASE="${MESHR_REHEARSAL_MODERATION_DATABASE:-meshr-rehearsal-moderation}"
  export MESHR_REHEARSAL_EVENTS_TOPIC="${MESHR_REHEARSAL_EVENTS_TOPIC:-meshr-rehearsal-events}"
  export MESHR_REHEARSAL_TOPOLOGY_SUBSCRIPTION="${MESHR_REHEARSAL_TOPOLOGY_SUBSCRIPTION:-meshr-rehearsal-topology}"
  export MESHR_REHEARSAL_WEB_ORIGIN="${MESHR_REHEARSAL_WEB_ORIGIN:-http://127.0.0.1:${web_port}}"
  export MESHR_REHEARSAL_RELEASE_SHA="${MESHR_REHEARSAL_RELEASE_SHA:-${EVENT_PLANE_IMAGE##*@sha256:}}"
}

require_immutable_images() {
  local variable value
  for variable in API_IMAGE WEB_IMAGE EVENT_PLANE_IMAGE; do
    value="${!variable:-}"
    if [[ ! "$value" =~ @sha256:[0-9a-f]{64}$ ]]; then
      echo "$variable must be supplied as an immutable image digest" >&2
      return 1
    fi
  done
}

random_secret() {
  openssl rand -hex 32
}

ensure_runtime_secret() {
  local secret_name="meshr-runtime-secrets"
  if k -n "$namespace" get secret "$secret_name" >/dev/null 2>&1; then
    if ! k -n "$namespace" get secret "$secret_name" -o json \
      | jq -e '(["identity-api-key", "internal-token", "moderation-authority-token", "renewal-recovery", "renewal-recovery-previous", "invitation-pepper", "invitation-pepper-previous"] - (.data | keys) | length) == 0' \
        >/dev/null; then
      echo "existing rehearsal runtime Secret is missing required keys" >&2
      return 1
    fi
  else
    local identity_api_key internal_token moderation_authority_token
    local renewal_recovery renewal_recovery_previous invitation_pepper invitation_pepper_previous
    identity_api_key="${MESHR_REHEARSAL_IDENTITY_API_KEY:-$(random_secret)}"
    internal_token="${MESHR_REHEARSAL_INTERNAL_TOKEN:-$(random_secret)}"
    moderation_authority_token="${MESHR_REHEARSAL_MODERATION_AUTHORITY_TOKEN:-$(random_secret)}"
    renewal_recovery="${MESHR_REHEARSAL_RENEWAL_RECOVERY_SECRET:-$(random_secret)}"
    renewal_recovery_previous="${MESHR_REHEARSAL_RENEWAL_RECOVERY_SECRET_PREVIOUS:-$(random_secret)}"
    invitation_pepper="${MESHR_REHEARSAL_INVITATION_PEPPER:-$(random_secret)}"
    invitation_pepper_previous="${MESHR_REHEARSAL_INVITATION_PEPPER_PREVIOUS:-$(random_secret)}"
    k -n "$namespace" create secret generic "$secret_name" \
      --from-literal="identity-api-key=$identity_api_key" \
      --from-literal="internal-token=$internal_token" \
      --from-literal="moderation-authority-token=$moderation_authority_token" \
      --from-literal="renewal-recovery=$renewal_recovery" \
      --from-literal="renewal-recovery-previous=$renewal_recovery_previous" \
      --from-literal="invitation-pepper=$invitation_pepper" \
      --from-literal="invitation-pepper-previous=$invitation_pepper_previous" >/dev/null
  fi
  k -n "$namespace" label secret "$secret_name" \
    app.kubernetes.io/part-of=meshr \
    meshr.social/environment=rehearsal \
    meshr.social/ephemeral=true \
    --overwrite >/dev/null
}

render_rehearsal() {
  local variables
  variables='${GCP_PROJECT_ID} ${API_IMAGE} ${WEB_IMAGE} ${EVENT_PLANE_IMAGE} ${MESHR_REHEARSAL_API_GSA} ${MESHR_REHEARSAL_BOOTSTRAP_GSA} ${MESHR_REHEARSAL_INGEST_GSA} ${MESHR_REHEARSAL_TOPOLOGY_GSA} ${MESHR_REHEARSAL_LIVE_GSA} ${MESHR_REHEARSAL_AUTHORITY_DATABASE} ${MESHR_REHEARSAL_TOPOLOGY_DATABASE} ${MESHR_REHEARSAL_AUDIT_DATABASE} ${MESHR_REHEARSAL_NOTIFICATIONS_DATABASE} ${MESHR_REHEARSAL_MODERATION_DATABASE} ${MESHR_REHEARSAL_EVENTS_TOPIC} ${MESHR_REHEARSAL_TOPOLOGY_SUBSCRIPTION} ${MESHR_REHEARSAL_WEB_ORIGIN} ${MESHR_REHEARSAL_RELEASE_SHA}'
  k kustomize "$repo_root/deploy/rehearsal" | envsubst "$variables"
}

dump_diagnostics() {
  echo "GCP rehearsal failed; collecting private-cluster diagnostics" >&2
  k -n "$namespace" get pods,deployments,replicasets,jobs,services -o wide >&2 || true
  k -n "$namespace" get events --sort-by=.lastTimestamp >&2 || true
  k -n "$namespace" logs job/production-store-bootstrap --all-containers=true --tail=200 >&2 || true
  k -n "$namespace" logs deployment/api --all-containers=true --tail=200 >&2 || true
  k -n "$namespace" logs deployment/ingest --all-containers=true --tail=200 >&2 || true
  k -n "$namespace" logs deployment/topology-materializer --all-containers=true --tail=200 >&2 || true
}

assert_private_runtime() {
  local service_json
  service_json="$(k -n "$namespace" get services -o json)"
  if ! jq -e '
      (.items | length) == 5
      and all(.items[];
        (.spec.type // "ClusterIP") == "ClusterIP"
        and ((.spec.externalIPs // []) | length) == 0
        and (.spec.loadBalancerIP // "") == ""
        and ([.spec.ports[]? | has("nodePort")] | any) == false)
    ' >/dev/null <<<"$service_json"; then
    echo "rehearsal namespace contains a non-private Service" >&2
    return 1
  fi
  if [[ -n "$(k -n "$namespace" get ingress -o name 2>/dev/null)" ]]; then
    echo "rehearsal namespace must not contain an Ingress" >&2
    return 1
  fi
  if k api-resources --api-group=gateway.networking.k8s.io -o name 2>/dev/null \
    | grep -qx 'gateways.gateway.networking.k8s.io'; then
    if [[ -n "$(k -n "$namespace" get gateways.gateway.networking.k8s.io -o name)" ]]; then
      echo "rehearsal namespace must not contain a Gateway" >&2
      return 1
    fi
  fi
}

wait_for_workloads() {
  local deployment
  for deployment in api web ingest topology-materializer live-gateway; do
    k -n "$namespace" rollout status "deployment/$deployment" --timeout=10m
  done
}

deploy() {
  require_project
  require_command kubectl
  require_command jq
  require_command envsubst
  require_command openssl
  require_immutable_images
  connect_cluster
  set_render_values
  trap dump_diagnostics ERR

  k apply -f "$repo_root/deploy/rehearsal/namespace.yaml" >/dev/null
  ensure_runtime_secret
  if k -n "$namespace" get deployment topology-materializer >/dev/null 2>&1; then
    k -n "$namespace" scale deployment/topology-materializer --replicas=0 >/dev/null
  fi
  k -n "$namespace" delete job production-store-bootstrap --ignore-not-found --wait=true >/dev/null
  render_rehearsal | k apply -f -
  k -n "$namespace" wait --for=condition=complete job/production-store-bootstrap --timeout=10m

  local bootstrap_record bootstrap_id projection_id
  bootstrap_record="$(k -n "$namespace" logs job/production-store-bootstrap \
    --all-containers=true --tail=200 \
    | jq -Rrc 'fromjson? | select(.event == "stores.initialized")' \
    | tail -n 1)"
  bootstrap_id="$(jq -r '.authorityBootstrapId // empty' <<<"$bootstrap_record")"
  projection_id="$(jq -r '.projectionBootstrapId // empty' <<<"$bootstrap_record")"
  if [[ -z "$bootstrap_id" || "$bootstrap_id" == "pending" || "$projection_id" != "$bootstrap_id" ]]; then
    echo "production bootstrap did not attest one authority generation" >&2
    return 1
  fi
  k -n "$namespace" patch configmap meshr-runtime --type=merge \
    --patch="$(jq -nc --arg id "$bootstrap_id" '{data:{MESHR_EXPECTED_AUTHORITY_BOOTSTRAP_ID:$id,MESHR_FORCE_PROJECTION_BOOTSTRAP_SCAN:"0"}}')" \
    >/dev/null
  k -n "$namespace" rollout restart deployment/topology-materializer >/dev/null
  wait_for_workloads
  assert_private_runtime
  trap - ERR
  echo "Meshr rehearsal deployed privately in namespace $namespace"
}

forward_pids=()
forward_log_dir=""

stop_port_forwards() {
  local pid
  for pid in "${forward_pids[@]:-}"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
    fi
  done
  forward_pids=()
  if [[ -n "$forward_log_dir" && -d "$forward_log_dir" ]]; then
    rm -r "$forward_log_dir"
  fi
  forward_log_dir=""
}

start_port_forward() {
  local service="$1"
  local mapping="$2"
  local log_file="$forward_log_dir/${service}.log"
  kubectl --context "$kube_context" -n "$namespace" port-forward \
    --address=127.0.0.1 "service/$service" "$mapping" >"$log_file" 2>&1 &
  forward_pids+=("$!")
}

wait_http() {
  local url="$1"
  local origin="${2:-}"
  local attempt
  for attempt in $(seq 1 60); do
    if [[ -n "$origin" ]]; then
      if curl --fail --silent --show-error -H "Origin: $origin" "$url" >/dev/null 2>&1; then
        return 0
      fi
    elif curl --fail --silent --show-error "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "timed out waiting for private port-forward: $url" >&2
  if [[ -n "$forward_log_dir" ]]; then
    sed -n '1,160p' "$forward_log_dir"/*.log >&2 || true
  fi
  return 1
}

start_port_forwards() {
  require_command curl
  forward_log_dir="$(mktemp -d "${TMPDIR:-/tmp}/meshr-rehearsal-forward.XXXXXX")"
  start_port_forward api "${api_port}:8787"
  start_port_forward web "${web_port}:8080"
  start_port_forward ingest "${ingest_port}:8080"
  start_port_forward live-gateway "${live_port}:8080"
  wait_http "http://127.0.0.1:${api_port}/healthz"
  wait_http "http://127.0.0.1:${web_port}/web-healthz"
  wait_http "http://127.0.0.1:${ingest_port}/readyz"
  wait_http "http://127.0.0.1:${live_port}/v1/live/snapshots/mesh-public" \
    "http://127.0.0.1:${web_port}"
}

build_smoke() {
  require_command bazelisk
  (cd "$repo_root" && bazelisk build //:smoke)
}

run_smoke_once() {
  local token
  token="$(k -n "$namespace" get secret meshr-runtime-secrets \
    -o go-template='{{index .data "internal-token" | base64decode}}')"
  MESHR_LOCAL_API_URL="http://127.0.0.1:${api_port}" \
  MESHR_LOCAL_WEB_URL="http://127.0.0.1:${web_port}" \
  MESHR_LOCAL_INGEST_URL="http://127.0.0.1:${ingest_port}" \
  MESHR_LOCAL_LIVE_URL="http://127.0.0.1:${live_port}" \
  MESHR_LOCAL_INTERNAL_TOKEN="$token" \
    node "$repo_root/bazel-bin/smoke.mjs"
}

prepare_smoke() {
  require_project
  require_command kubectl
  require_command jq
  connect_cluster
  wait_for_workloads
  assert_private_runtime
  build_smoke
}

smoke() {
  prepare_smoke
  trap stop_port_forwards RETURN
  start_port_forwards
  run_smoke_once
  trap - RETURN
  stop_port_forwards
}

restart_smoke() {
  prepare_smoke
  local event_file
  event_file="$(mktemp "${TMPDIR:-/tmp}/meshr-rehearsal-smoke-event.XXXXXX")"
  trap 'stop_port_forwards; rm -f "$event_file"' RETURN

  start_port_forwards
  (export MESHR_LOCAL_SMOKE_EVENT_FILE="$event_file"; run_smoke_once)
  stop_port_forwards

  k -n "$namespace" rollout restart \
    deployment/api deployment/web deployment/ingest \
    deployment/topology-materializer deployment/live-gateway >/dev/null
  wait_for_workloads
  start_port_forwards
  (export MESHR_LOCAL_SMOKE_REPLAY_FILE="$event_file"; run_smoke_once)

  trap - RETURN
  stop_port_forwards
  rm -f "$event_file"
}

status() {
  require_project
  require_command gcloud
  require_command jq
  require_command kubectl
  local presence
  presence="$(cluster_presence)"
  if [[ "$presence" == "absent" ]]; then
    echo "Meshr rehearsal cluster is absent: $cluster_name ($region)"
    return 0
  fi
  local description
  description="$(cluster_json)"
  assert_rehearsal_cluster "$description"
  jq '{name, location, status, autopilot: .autopilot.enabled, workloadPool: .workloadIdentityConfig.workloadPool, labels: .resourceLabels}' <<<"$description"
  connect_cluster
  k -n "$namespace" get deployments,pods,jobs,services -o wide
  assert_private_runtime
}

destroy_cluster() {
  require_project
  require_command gcloud
  require_command jq
  local presence
  presence="$(cluster_presence)"
  if [[ "$presence" == "absent" ]]; then
    echo "Meshr rehearsal cluster is already absent: $cluster_name ($region)"
    return 0
  fi
  # Deletion is authorized only after the live cluster proves all three
  # script-owned labels plus Autopilot and Workload Identity identity.
  assert_rehearsal_cluster "$(cluster_json)"
  gcloud container clusters delete "$cluster_name" \
    --project "$project_id" \
    --region "$region" \
    --quiet
  echo "Deleted ephemeral Meshr rehearsal cluster: $cluster_name ($region)"
}

case "${1:-}" in
  create-cluster) create_cluster ;;
  deploy) deploy ;;
  smoke) smoke ;;
  restart-smoke) restart_smoke ;;
  status) status ;;
  destroy-cluster) destroy_cluster ;;
  *)
    echo "usage: $0 {create-cluster|deploy|smoke|restart-smoke|status|destroy-cluster}" >&2
    exit 2
    ;;
esac
