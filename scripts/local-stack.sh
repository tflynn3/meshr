#!/usr/bin/env bash
set -euo pipefail

cluster_name="meshr-local"
colima_profile="meshr-local"
namespace="meshr-local"
local_internal_secret="local-internal-auth"
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

assert_loopback_bindings() {
  local cluster_nodes
  if ! cluster_nodes="$(docker ps --all \
    --filter "label=k3d.cluster=${cluster_name}" \
    --format '{{.Names}}')"; then
    echo "cannot list the Docker nodes for $cluster_name; refusing to operate on an unverified local cluster" >&2
    return 1
  fi
  if [[ -z "$cluster_nodes" ]]; then
    echo "cannot find the Docker nodes for $cluster_name; refusing to operate on an unverified local cluster" >&2
    return 1
  fi

  local -a nodes=()
  local node
  while IFS= read -r node; do
    [[ -n "$node" ]] && nodes+=("$node")
  done <<<"$cluster_nodes"

  local unsafe_nodes
  if ! unsafe_nodes="$(docker inspect "${nodes[@]}" --format '{{if or (eq .HostConfig.NetworkMode "host") .HostConfig.PublishAllPorts}}{{.Name}}{{end}}' 2>/dev/null)"; then
    echo "cannot inspect the Docker nodes for $cluster_name; refusing to operate on an unverified local cluster" >&2
    return 1
  fi
  if [[ -n "$unsafe_nodes" ]]; then
    echo "existing $cluster_name cluster uses host networking or Docker PublishAllPorts; refusing to mutate it" >&2
    return 1
  fi

  local bindings
  if ! bindings="$(docker inspect "${nodes[@]}" --format '{{range $port, $entries := .NetworkSettings.Ports}}{{range $entries}}{{printf "%s\t%s\t%s\n" $port .HostIp .HostPort}}{{end}}{{end}}' 2>/dev/null)"; then
    echo "cannot inspect the published ports for $cluster_name; refusing to operate on an unverified local cluster" >&2
    return 1
  fi

  local api_found=0
  local http_found=0
  local container_port host_ip host_port
  while IFS=$'\t' read -r container_port host_ip host_port; do
    [[ -n "$container_port" ]] || continue
    case "$host_ip" in
      127.0.0.1|::1) ;;
      *)
        echo "existing $cluster_name cluster publishes $container_port on ${host_ip:-0.0.0.0}:$host_port instead of loopback" >&2
        echo "refusing to start or mutate it; when safe, run 'npm run local:down' and then 'npm run local:up' to recreate it with loopback-only bindings" >&2
        return 1
        ;;
    esac
    [[ "$container_port" == "6443/tcp" ]] && api_found=1
    [[ "$container_port" == "80/tcp" ]] && http_found=1
  done <<<"$bindings"

  if (( api_found == 0 || http_found == 0 )); then
    echo "existing $cluster_name cluster is missing the expected loopback Kubernetes API or HTTP binding; refusing to mutate it" >&2
    return 1
  fi
}

rotate_local_internal_token() (
  require_command openssl
  local token token_file
  token_file="$(mktemp "${TMPDIR:-/tmp}/meshr-local-internal-token.XXXXXX")"
  trap 'rm -f "$token_file"' EXIT
  chmod 600 "$token_file"
  token="$(openssl rand -hex 32)"
  if [[ ! "$token" =~ ^[0-9a-f]{64}$ ]]; then
    echo "openssl did not produce the expected 256-bit local token" >&2
    return 1
  fi
  printf '%s' "$token" >"$token_file"
  kubectl apply -f "$repo_root/deploy/local/namespace.yaml" >/dev/null
  kubectl -n "$namespace" create secret generic "$local_internal_secret" \
    --from-file="token=$token_file" \
    --dry-run=client \
    -o yaml \
    | kubectl apply -f - >/dev/null
)

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
    # k3d stages each archive under a timestamped basename. Passing multiple
    # tarballs in one invocation can collide when they are created in the same
    # second, leaving one image absent from a node. Import each archive in its
    # own lifecycle so every image is copied deterministically.
    local archive
    for archive in \
      "bazel-bin/images/api_${architecture}_load/tarball.tar" \
      "bazel-bin/images/event_plane_${architecture}_load/tarball.tar" \
      "bazel-bin/images/web_${architecture}_load/tarball.tar"; do
      k3d image import --cluster "$cluster_name" "$archive"
    done
  )
}

dump_diagnostics() {
  echo "local stack failed; collecting Kubernetes diagnostics" >&2
  kubectl -n "$namespace" get pods,rs,pvc,pv -o wide >&2 || true
  kubectl -n "$namespace" get events --sort-by=.lastTimestamp >&2 || true
  kubectl -n "$namespace" describe deployment/api >&2 || true
  kubectl -n "$namespace" describe pvc/api-sqlite >&2 || true
  kubectl -n "$namespace" logs deployment/api --all-containers=true --tail=200 >&2 || true
}

up() {
  require_command k3d
  select_runtime
  local cluster_created=0
  if ! k3d cluster list --no-headers 2>/dev/null | awk '{print $1}' | grep -qx "$cluster_name"; then
    cluster_created=1
    k3d cluster create --config "$repo_root/deploy/local/k3d.yaml"
    if ! assert_loopback_bindings; then
      k3d cluster stop "$cluster_name" >/dev/null 2>&1 || true
      return 1
    fi
  else
    assert_loopback_bindings
    k3d cluster start "$cluster_name"
    k3d kubeconfig merge "$cluster_name" --kubeconfig-switch-context >/dev/null
  fi
  select_cluster
  trap dump_diagnostics ERR
  build_images
  rotate_local_internal_token
  kubectl apply -k "$repo_root/deploy/local"
  # A fresh cluster already starts pods from the just-built images. Restarting
  # before that first rollout is ready races the Recreate API strategy and can
  # strand its single-writer PVC at zero updated replicas. Existing clusters
  # still need an explicit restart to pick up newly imported images.
  if (( cluster_created == 0 )); then
    kubectl -n "$namespace" rollout restart \
      deployment/api deployment/web deployment/ingest \
      deployment/topology-materializer deployment/live-gateway
  fi
  kubectl -n "$namespace" rollout status deployment/firestore --timeout=5m
  kubectl -n "$namespace" rollout status deployment/pubsub --timeout=5m
  kubectl -n "$namespace" rollout status deployment/api --timeout=5m
  kubectl -n "$namespace" rollout status deployment/web --timeout=5m
  kubectl -n "$namespace" rollout status deployment/ingest --timeout=5m
  kubectl -n "$namespace" rollout status deployment/topology-materializer --timeout=5m
  kubectl -n "$namespace" rollout status deployment/live-gateway --timeout=5m
  trap - ERR
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
  assert_loopback_bindings
  select_cluster
  local event_file internal_token
  internal_token="$(kubectl -n "$namespace" get secret "$local_internal_secret" -o go-template='{{index .data "token" | base64decode}}')"
  if [[ ! "$internal_token" =~ ^[0-9a-f]{64}$ ]]; then
    echo "the live $local_internal_secret token is missing or invalid; run 'npm run local:up' to rotate it" >&2
    return 1
  fi
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
  wait_json() {
    local url="$1"
    local attempts=0
    local response
    until response="$(curl --fail --silent --show-error "$url" 2>/dev/null)" \
      && jq -e 'type == "object"' >/dev/null 2>&1 <<<"$response"; do
      attempts=$((attempts + 1))
      if (( attempts >= 60 )); then
        echo "timed out waiting for JSON response from $url after rollout" >&2
        return 1
      fi
      sleep 1
    done
  }
  wait_health() {
    local url="$1"
    local attempts=0
    local response
    until response="$(curl --fail --silent --show-error "$url" 2>/dev/null)" \
      && jq -e 'type == "object" and .status == "ok" and .database == "ok"' >/dev/null 2>&1 <<<"$response"; do
      attempts=$((attempts + 1))
      if (( attempts >= 60 )); then
        echo "timed out waiting for healthy JSON response from $url after rollout" >&2
        return 1
      fi
      sleep 1
    done
  }
  (
    cd "$repo_root"
    bazelisk build //:smoke
    MESHR_LOCAL_INTERNAL_TOKEN="$internal_token" \
      MESHR_LOCAL_SMOKE_EVENT_FILE="$event_file" \
      node bazel-bin/smoke.mjs
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
  wait_health http://localhost:8080/healthz
  wait_http http://localhost:8080/
  # The ingest process has a dependency-aware readiness endpoint. Waiting on
  # it through the same ingress closes the gap between a ready HTTP listener
  # and a Firestore/Pub/Sub client that can actually accept an event.
  wait_json "${MESHR_LOCAL_URL:-http://localhost:8080}/__local/ingest/readyz"
  wait_json "${MESHR_LOCAL_URL:-http://localhost:8080}/v1/live/snapshots/mesh-public"
  # Require the complete endpoint set to remain healthy across one additional
  # ingress refresh. This avoids starting the replay while Traefik is still
  # replacing a terminating endpoint and briefly serves the web shell for an
  # API path.
  sleep 1
  wait_health "${MESHR_LOCAL_URL:-http://localhost:8080}/healthz"
  wait_json "${MESHR_LOCAL_URL:-http://localhost:8080}/__local/ingest/readyz"
  wait_json "${MESHR_LOCAL_URL:-http://localhost:8080}/v1/live/snapshots/mesh-public"
  (
    cd "$repo_root"
    MESHR_LOCAL_INTERNAL_TOKEN="$internal_token" \
      MESHR_LOCAL_SMOKE_REPLAY_FILE="$event_file" \
      node bazel-bin/smoke.mjs
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
