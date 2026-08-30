#!/usr/bin/env bash
set -euo pipefail

# Start the fast local demo loop without disturbing an already-running service
# or the isolated k3d stack. The launcher owns only the processes it starts.
repo_root="$(builtin cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null && pwd -P)"
api_url="http://127.0.0.1:8787"
web_url="http://127.0.0.1:5173"
api_health_url="${api_url%/}/healthz"

api_pid=""
web_pid=""
demo_heartbeat_pid=""

echo "Preparing the local demo story"
(
  cd "$repo_root"
  npm run demo:seed
)

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  stop_tree() {
    local pid="$1"
    local child
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    while read -r child; do
      [[ -n "$child" ]] && stop_tree "$child"
    done < <(pgrep -P "$pid" 2>/dev/null || true)
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  }
  [[ -n "$web_pid" ]] && stop_tree "$web_pid"
  [[ -n "$demo_heartbeat_pid" ]] && stop_tree "$demo_heartbeat_pid"
  [[ -n "$api_pid" ]] && stop_tree "$api_pid"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

healthy() {
  local url="$1"
  curl --fail --silent --show-error --max-time 2 "$url" >/dev/null 2>&1
}

wait_for() {
  local label="$1"
  local url="$2"
  local pid="${3:-}"
  local attempts=0
  until healthy "$url"; do
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      if wait "$pid"; then
        echo "$label exited before becoming ready." >&2
        return 1
      else
        local exit_code=$?
        echo "$label exited before becoming ready (status ${exit_code})." >&2
        return "$exit_code"
      fi
    fi
    attempts=$((attempts + 1))
    if (( attempts >= 60 )); then
      echo "timed out waiting for $label at $url" >&2
      return 1
    fi
    sleep 0.5
  done
}

if healthy "$api_health_url"; then
  echo "Meshr API already healthy at $api_url"
else
  echo "Starting Meshr API at $api_url"
  (
    cd "$repo_root"
    exec npm run dev:server
  ) &
  api_pid=$!
  wait_for "Meshr API" "$api_health_url" "$api_pid"
fi

echo "Connecting local demo hosts through the native session flow"
(
  cd "$repo_root"
  npm run demo:connect
)

if healthy "$web_url/"; then
  echo "Meshr web app already serving at $web_url"
else
  echo "Starting Meshr web app at $web_url"
  (
    cd "$repo_root"
    exec npm run dev
  ) &
  web_pid=$!
  wait_for "Meshr web app" "$web_url/" "$web_pid"
fi

echo "Keeping local demo sessions online while this launcher runs"
(
  cd "$repo_root"
  while :; do
    npm run demo:heartbeat >/dev/null 2>&1
    sleep 30
  done
) &
demo_heartbeat_pid=$!

echo "Meshr local demo ready: $web_url"
if [[ -z "$api_pid" && -z "$web_pid" && -z "$demo_heartbeat_pid" ]]; then
  exit 0
fi

echo "Press Ctrl-C to stop only the services started by this command."
while :; do
  running=0
  for service in api web demo_heartbeat; do
    pid="${service}_pid"
    current_pid="${!pid}"
    if [[ -n "$current_pid" ]] && kill -0 "$current_pid" 2>/dev/null; then
      running=1
      continue
    fi
    [[ -z "$current_pid" ]] && continue
    if wait "$current_pid"; then
      exit_code=0
    else
      exit_code=$?
    fi
    # A service stopping cleanly is still a failed demo lifecycle once the
    # launcher has taken ownership of it; keep the command's result useful to
    # scripts and CI instead of reporting a false success.
    (( exit_code == 0 )) && exit_code=1
    echo "Meshr ${service} process exited (status ${exit_code})." >&2
    exit "$exit_code"
  done
  (( running == 0 )) && exit 0
  sleep 0.5
done
