#!/usr/bin/env bash
set -euo pipefail

# Run the two supported native-runtime acceptance flows against a canary or
# production origin. Credentials arrive through the protected CI environment;
# raw evidence stays in a private runner-temp directory and only the redacted
# receipt is left for the caller to archive.

: "${MESHR_RELEASE_ENVIRONMENT:?Set MESHR_RELEASE_ENVIRONMENT to canary or production}"
: "${MESHR_RELEASE_ORIGIN:?Set MESHR_RELEASE_ORIGIN to the same-origin deployment}"
: "${MESHR_RELEASE_SHA:?Set MESHR_RELEASE_SHA to the deployed commit SHA}"
: "${MESHR_RELEASE_CLAUDE_STATE_JSON:?Set the protected Claude runtime state JSON secret}"
: "${MESHR_RELEASE_OPENCLAW_STATE_JSON:?Set the protected OpenClaw runtime state JSON secret}"
: "${MESHR_RELEASE_OPENCLAW_CONFIG_JSON:?Set the protected OpenClaw config JSON secret}"
: "${MESHR_RELEASE_CLAUDE_BINDINGS:?Set two Claude binding selectors separated by a comma}"
: "${MESHR_RELEASE_OPENCLAW_AGENTS:?Set two OpenClaw agent IDs separated by a comma}"
: "${MESHR_RELEASE_OPENCLAW_BINDINGS:?Set two OpenClaw binding selectors separated by a comma}"
: "${MESHR_RELEASE_VALIDATION_MESH_ID:?Set the private release validation mesh ID}"
: "${MESHR_RELEASE_VALIDATION_TOPIC_ID:?Set the release validation topic ID}"

if [[ "$MESHR_RELEASE_VALIDATION_MESH_ID" == "mesh-public" ]]; then
  echo "MESHR_RELEASE_VALIDATION_MESH_ID must not be mesh-public" >&2
  exit 1
fi

case "$MESHR_RELEASE_ENVIRONMENT" in
  canary|production) ;;
  *) echo "MESHR_RELEASE_ENVIRONMENT must be canary or production" >&2; exit 1 ;;
esac

release_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
work_dir="$(mktemp -d "$release_root/meshr-native-acceptance.XXXXXX")"
claude_state_dir="$work_dir/claude-session"
openclaw_dir="$work_dir/openclaw-state"
openclaw_state_dir="$work_dir/openclaw-session"
mkdir -p "$claude_state_dir" "$openclaw_dir" "$openclaw_state_dir"
chmod 700 "$work_dir" "$claude_state_dir" "$openclaw_dir" "$openclaw_state_dir"
claude_gate_pid=""
openclaw_gate_pid=""
cleanup() {
  if [[ -n "$claude_gate_pid" ]]; then kill "$claude_gate_pid" 2>/dev/null || true; fi
  if [[ -n "$openclaw_gate_pid" ]]; then kill "$openclaw_gate_pid" 2>/dev/null || true; fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

claude_state_path="$claude_state_dir/state.json"
openclaw_state_path="$openclaw_state_dir/state.json"
config_path="$openclaw_dir/openclaw.json"
printf '%s\n' "$MESHR_RELEASE_CLAUDE_STATE_JSON" > "$claude_state_path"
printf '%s\n' "$MESHR_RELEASE_OPENCLAW_STATE_JSON" > "$openclaw_state_path"
chmod 600 "$claude_state_path" "$openclaw_state_path"

# The config secret is a template so the same reviewed OpenClaw setup can be
# used on an ephemeral runner. These placeholders are the only substitutions;
# malformed JSON or an unexpanded path fails before any agent process starts.
MESHR_CONFIG_TEMPLATE="$MESHR_RELEASE_OPENCLAW_CONFIG_JSON" \
MESHR_CONFIG_PATH="$config_path" \
MESHR_STATE_PATH="$openclaw_state_path" \
MESHR_RELEASE_ORIGIN="$MESHR_RELEASE_ORIGIN" \
MESHR_PLUGIN_ROOT="$work_dir/package-consumer/node_modules/@meshr/openclaw" \
node <<'NODE'
const { writeFileSync } = require('node:fs');
const template = process.env.MESHR_CONFIG_TEMPLATE;
if (typeof template !== 'string' || !template) throw new Error('OpenClaw config template is empty');
const rendered = template
  .replaceAll('__MESHR_STATE_PATH__', process.env.MESHR_STATE_PATH)
  .replaceAll('__MESHR_SERVER_URL__', process.env.MESHR_RELEASE_ORIGIN)
  .replaceAll('__MESHR_PLUGIN_ROOT__', process.env.MESHR_PLUGIN_ROOT);
const parsed = JSON.parse(rendered);
if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('OpenClaw config must be a JSON object');
const plugins = parsed.plugins && typeof parsed.plugins === 'object' && !Array.isArray(parsed.plugins)
  ? parsed.plugins
  : (parsed.plugins = {});
const load = plugins.load && typeof plugins.load === 'object' && !Array.isArray(plugins.load)
  ? plugins.load
  : (plugins.load = {});
const paths = Array.isArray(load.paths) ? load.paths.filter((value) => value !== process.env.MESHR_PLUGIN_ROOT) : [];
load.paths = [process.env.MESHR_PLUGIN_ROOT, ...paths];
writeFileSync(process.env.MESHR_CONFIG_PATH, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
NODE
chmod 600 "$config_path"

# The raw state/config JSON contains pairing secrets and private keys. They are
# needed only to render the private files; do not let native host processes (or
# npm's child process tree) inherit them.
unset MESHR_RELEASE_CLAUDE_STATE_JSON MESHR_RELEASE_OPENCLAW_STATE_JSON MESHR_RELEASE_OPENCLAW_CONFIG_JSON

# Build and install the exact candidate packages into an isolated consumer.
# Native acceptance must exercise the artifacts a user will receive, not a
# repository-local TypeScript entrypoint or an in-place plugin checkout.
package_root="$work_dir/package-consumer"
pack_dir="$work_dir/packages"
mkdir -p "$pack_dir" "$package_root"
chmod 700 "$pack_dir" "$package_root"
npm ci --prefix packages/mcp --ignore-scripts --no-audit --no-fund
npm ci --prefix integrations/openclaw --ignore-scripts --no-audit --no-fund
(
  cd packages/mcp
  npm pack --json --pack-destination "$pack_dir" > "$work_dir/mcp-pack.json"
)
(
  cd integrations/openclaw
  npm pack --json --pack-destination "$pack_dir" > "$work_dir/openclaw-pack.json"
)
mcp_tarball="$pack_dir/$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[0].filename)' "$work_dir/mcp-pack.json")"
openclaw_tarball="$pack_dir/$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[0].filename)' "$work_dir/openclaw-pack.json")"
printf '%s\n' '{"name":"meshr-native-package-consumer","private":true,"type":"module"}' > "$package_root/package.json"
chmod 600 "$package_root/package.json"
npm install --ignore-scripts --no-audit --no-fund --prefix "$package_root" "$mcp_tarball" "$openclaw_tarball"
mcp_command="$package_root/node_modules/.bin/meshr-mcp"
openclaw_plugin_root="$package_root/node_modules/@meshr/openclaw"
openclaw_command="${MESHR_RELEASE_OPENCLAW_COMMAND:-$package_root/node_modules/.bin/openclaw}"
test -x "$mcp_command"
test -f "$openclaw_plugin_root/openclaw.plugin.json"
test -f "$openclaw_plugin_root/dist/index.js"
if [[ "$openclaw_command" != /* || ! -x "$openclaw_command" ]]; then
  echo "MESHR_RELEASE_OPENCLAW_COMMAND must be an executable absolute path (or let the isolated package consumer binary be used)." >&2
  exit 1
fi
"$mcp_command" --help >/dev/null

# Runtime bearer tokens are intentionally short-lived. Mint fresh host-owned
# sessions from the persisted Ed25519 binding keys so a protected CI secret can
# be reused across releases without embedding an expired token in the secret.
npm run refresh:sessions -- \
  --state-file "$claude_state_path" \
  --server "$MESHR_RELEASE_ORIGIN" \
  --selectors "$MESHR_RELEASE_CLAUDE_BINDINGS"
npm run refresh:sessions -- \
  --state-file "$openclaw_state_path" \
  --server "$MESHR_RELEASE_ORIGIN" \
  --selectors "$MESHR_RELEASE_OPENCLAW_BINDINGS" \
  --openclaw-agents "$MESHR_RELEASE_OPENCLAW_AGENTS"

claude_args=(
  --runtime claude
  --bindings "claude=$MESHR_RELEASE_CLAUDE_BINDINGS"
  --state-dir "$claude_state_dir"
  --server "$MESHR_RELEASE_ORIGIN"
  --evidence "$work_dir/claude.json"
  --claude-command "${MESHR_RELEASE_CLAUDE_COMMAND:-claude}"
)
if [[ -n "${MESHR_RELEASE_CLAUDE_MODEL:-}" ]]; then
  claude_args+=(--claude-model "$MESHR_RELEASE_CLAUDE_MODEL")
fi
MESHR_EVIDENCE_ENV="$MESHR_RELEASE_ENVIRONMENT" \
MESHR_RELEASE_SHA="$MESHR_RELEASE_SHA" \
MESHR_RELEASE_VALIDATION_MESH_ID="$MESHR_RELEASE_VALIDATION_MESH_ID" \
MESHR_RELEASE_VALIDATION_TOPIC_ID="$MESHR_RELEASE_VALIDATION_TOPIC_ID" \
MESHR_MCP_COMMAND="$mcp_command" \
npm run live -- "${claude_args[@]}"

# Revalidate Claude's phase-bound lifecycle witnesses. The live runner records
# the host-exit timestamp and observes the offline edge before it starts the
# next phase, so this gate does not depend on the other runtime's duration.
npm run verify:session-gates -- \
  --state-file "$claude_state_path" \
  --server "$MESHR_RELEASE_ORIGIN" \
  --selectors "$MESHR_RELEASE_CLAUDE_BINDINGS" \
  --evidence "$work_dir/claude.json" \
  --output "$work_dir/claude-lifecycle.json" \
  --offline-wait-seconds "${MESHR_RELEASE_OFFLINE_WAIT_SECONDS:-90}" &
claude_gate_pid=$!

openclaw_args=(
  --agents "$MESHR_RELEASE_OPENCLAW_AGENTS"
  --state-file "$openclaw_state_path"
  --openclaw-state-dir "$openclaw_dir"
  --openclaw-config "$config_path"
  --connector-state "$openclaw_state_path"
  --server "$MESHR_RELEASE_ORIGIN"
  --openclaw-command "$openclaw_command"
  --evidence "$work_dir/openclaw.json"
)
if [[ -n "${MESHR_RELEASE_OPENCLAW_BINDINGS:-}" ]]; then
  openclaw_args+=(--bindings "$MESHR_RELEASE_OPENCLAW_BINDINGS")
fi
if [[ -n "${MESHR_RELEASE_OPENCLAW_MODEL:-}" ]]; then
  openclaw_args+=(--model "$MESHR_RELEASE_OPENCLAW_MODEL")
fi
MESHR_EVIDENCE_ENV="$MESHR_RELEASE_ENVIRONMENT" \
MESHR_RELEASE_SHA="$MESHR_RELEASE_SHA" \
MESHR_RELEASE_VALIDATION_MESH_ID="$MESHR_RELEASE_VALIDATION_MESH_ID" \
MESHR_RELEASE_VALIDATION_TOPIC_ID="$MESHR_RELEASE_VALIDATION_TOPIC_ID" \
npm run live:openclaw -- "${openclaw_args[@]}"

# Revalidate OpenClaw's phase-bound lifecycle witnesses and signed-session
# fencing. Both gates can now finish without extending the recorded sessions.
npm run verify:session-gates -- \
  --state-file "$openclaw_state_path" \
  --server "$MESHR_RELEASE_ORIGIN" \
  --selectors "$MESHR_RELEASE_OPENCLAW_BINDINGS" \
  --evidence "$work_dir/openclaw.json" \
  --output "$work_dir/openclaw-lifecycle.json" \
  --offline-wait-seconds "${MESHR_RELEASE_OFFLINE_WAIT_SECONDS:-90}" &
openclaw_gate_pid=$!
wait "$claude_gate_pid"
wait "$openclaw_gate_pid"

npm run evidence:receipt -- \
  --evidence "$work_dir/claude.json" \
  --evidence "$work_dir/openclaw.json" \
  --lifecycle "$work_dir/claude-lifecycle.json" \
  --lifecycle "$work_dir/openclaw-lifecycle.json" \
  --output "$work_dir/runtime-receipt.json"
npm run verify:runtime-evidence -- \
  --environment "$MESHR_RELEASE_ENVIRONMENT" \
  --origin "$MESHR_RELEASE_ORIGIN" \
  --sha "$MESHR_RELEASE_SHA" \
  --mesh-id "$MESHR_RELEASE_VALIDATION_MESH_ID" \
  --topic-id "$MESHR_RELEASE_VALIDATION_TOPIC_ID" \
  --evidence "$work_dir/runtime-receipt.json"

if [[ -n "${MESHR_RELEASE_RECEIPT_OUTPUT:-}" ]]; then
  install -m 600 "$work_dir/runtime-receipt.json" "$MESHR_RELEASE_RECEIPT_OUTPUT"
  printf 'runtime_receipt=%s\n' "$MESHR_RELEASE_RECEIPT_OUTPUT"
fi
