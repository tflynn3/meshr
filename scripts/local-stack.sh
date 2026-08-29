#!/usr/bin/env bash
set -euo pipefail

cluster_name="meshr-local"
colima_profile="meshr-local"
namespace="meshr-local"
repo_root="$(builtin cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null && pwd -P)"
export K3D_IMAGE_LOADBALANCER="ghcr.io/k3d-io/k3d-proxy:5.9.0"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

select_runtime() {
  require_command docker
  # macOS development uses an isolated Colima VM so the default Docker
  # context remains untouched. Linux CI runners already provide an isolated
  # Docker daemon; requiring Colima there made the canonical k3d gate
  # impossible to run in GitHub Actions.
  if [[ "$(uname -s)" == "Darwin" ]]; then
    require_command colima
    if ! colima status --profile "$colima_profile" >/dev/null 2>&1; then
      colima start --profile "$colima_profile" --runtime docker --vm-type qemu --kubernetes=false \
        --cpu 4 --memory 8 --disk 40
    fi
    docker context use "colima-${colima_profile}" >/dev/null
  fi
  docker info >/dev/null
}

select_cluster() {
  require_command kubectl
  kubectl config use-context "k3d-${cluster_name}" >/dev/null
}

build_images() {
  require_command bazelisk
  local architecture
  case "$(uname -m)" in
    arm64|aarch64) architecture="arm64" ;;
    x86_64|amd64) architecture="amd64" ;;
    *) echo "unsupported local architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  (
    cd "$repo_root"
    bazelisk build \
      "//images:api_${architecture}_archive" \
      "//images:event_plane_${architecture}_archive" \
      "//images:web_${architecture}_archive"
    k3d image import --cluster "$cluster_name" \
      "bazel-bin/images/api_${architecture}_load/tarball.tar" \
      "bazel-bin/images/event_plane_${architecture}_load/tarball.tar" \
      "bazel-bin/images/web_${architecture}_load/tarball.tar"
  )
}

up() {
  require_command k3d
  select_runtime
  if ! k3d cluster list --no-headers 2>/dev/null | awk '{print $1}' | grep -qx "$cluster_name"; then
    k3d cluster create --config "$repo_root/deploy/local/k3d.yaml"
  else
    k3d cluster start "$cluster_name"
    k3d kubeconfig merge "$cluster_name" --kubeconfig-switch-context >/dev/null
  fi
  select_cluster
  build_images
  kubectl apply -k "$repo_root/deploy/local"
  kubectl -n "$namespace" rollout restart \
    deployment/api deployment/web deployment/ingest \
    deployment/topology-materializer deployment/live-gateway
  kubectl -n "$namespace" rollout status deployment/firestore --timeout=5m
  kubectl -n "$namespace" rollout status deployment/pubsub --timeout=5m
  kubectl -n "$namespace" rollout status deployment/api --timeout=5m
  kubectl -n "$namespace" rollout status deployment/web --timeout=5m
  kubectl -n "$namespace" rollout status deployment/ingest --timeout=5m
  kubectl -n "$namespace" rollout status deployment/topology-materializer --timeout=5m
  kubectl -n "$namespace" rollout status deployment/live-gateway --timeout=5m
  echo "Meshr local stack is ready at http://localhost:8080/"
}

status() {
  select_runtime
  select_cluster
  kubectl -n "$namespace" get pods,services,ingress
}

logs() {
  select_runtime
  select_cluster
  kubectl -n "$namespace" logs -l app.kubernetes.io/part-of=meshr \
    --all-containers=true --prefix=true --tail=200
}

smoke() {
  select_runtime
  select_cluster
  local event_file
  event_file="$(mktemp "${TMPDIR:-/tmp}/meshr-local-smoke-event.XXXXXX")"
  trap 'rm -f "$event_file"' RETURN
  wait_http() {
    local url="$1"
    local attempts=0
    until curl --fail --silent --show-error "$url" >/dev/null 2>&1; do
      attempts=$((attempts + 1))
      if (( attempts >= 60 )); then
        echo "timed out waiting for $url after rollout" >&2
        return 1
      fi
      sleep 1
    done
  }
  (
    cd "$repo_root"
    bazelisk build //:smoke
    MESHR_LOCAL_SMOKE_EVENT_FILE="$event_file" node bazel-bin/smoke.mjs
  )
  kubectl -n "$namespace" rollout restart \
    deployment/api deployment/web deployment/ingest \
    deployment/topology-materializer deployment/live-gateway
  kubectl -n "$namespace" rollout status deployment/api --timeout=5m
  kubectl -n "$namespace" rollout status deployment/web --timeout=5m
  kubectl -n "$namespace" rollout status deployment/ingest --timeout=5m
  kubectl -n "$namespace" rollout status deployment/topology-materializer --timeout=5m
  kubectl -n "$namespace" rollout status deployment/live-gateway --timeout=5m
  # Traefik can briefly retain the old endpoint set after the deployment
  # rollout reports complete. Warm the same-origin ingress before replaying so
  # a transient 504 is not mistaken for event-plane loss.
  wait_http http://localhost:8080/healthz
  wait_http http://localhost:8080/
  (
    cd "$repo_root"
    MESHR_LOCAL_SMOKE_REPLAY_FILE="$event_file" node bazel-bin/smoke.mjs
  )
}

down() {
  select_runtime
  if k3d cluster list --no-headers 2>/dev/null | awk '{print $1}' | grep -qx "$cluster_name"; then
    k3d cluster delete "$cluster_name"
  fi
}

case "${1:-}" in
  up) up ;;
  status) status ;;
  logs) logs ;;
  smoke) smoke ;;
  down) down ;;
  *)
    echo "usage: $0 {up|status|logs|smoke|down}" >&2
    exit 2
    ;;
esac
